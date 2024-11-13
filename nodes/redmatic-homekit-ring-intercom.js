const { RingApi } = require('ring-client-api');
const { map, throttleTime } = require('rxjs/operators');
const EventEmitter = require('events');

module.exports = function (RED) {
    class RedMaticHomeKitRingDevice extends EventEmitter {
        constructor(config, intercom) {
            super(); // Initialize EventEmitter

            this.bridgeConfig = RED.nodes.getNode(config.bridgeConfig);
            if (!this.bridgeConfig) {
                console.error('Missing bridge configuration');
                return;
            }

            const { hap } = this.bridgeConfig;
            this.name = config.name || 'Ring Intercom';
            this.id = intercom.device_id || 'unknown_id'; // Ensure ID is defined
            const acc = this.bridgeConfig.accessory({ id: this.id, name: this.name });

            this.initHomeKit(acc, hap, intercom);
        }

        initHomeKit(acc, hap, intercom) {
            const subtype = '0';

            if (!acc.isConfigured) {
                // Configure Accessory Information
                const accessoryInfo = acc.getService(hap.Service.AccessoryInformation);
                accessoryInfo
                    .setCharacteristic(hap.Characteristic.Manufacturer, 'Ring')
                    .setCharacteristic(hap.Characteristic.Model, 'Intercom Handset Audio')
                    .setCharacteristic(hap.Characteristic.SerialNumber, intercom.device_id || 'Unknown');

                // Add Lock Mechanism Service
                const lockService = acc.addService(hap.Service.LockMechanism, this.name);

                // Correctly set Lock Mechanism as the primary service
                lockService.setPrimaryService(true);

                // Add Stateless Programmable Switch (Doorbell)
                const doorbellService = acc.addService(hap.Service.StatelessProgrammableSwitch, `${this.name} Doorbell`, subtype);

                // Restrict ProgrammableSwitchEvent to SINGLE_PRESS
                doorbellService.getCharacteristic(hap.Characteristic.ProgrammableSwitchEvent)
                    .setProps({
                        maxValue: hap.Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS,
                    });

                // Add Battery Service if applicable
                if (intercom.battery_life !== null && intercom.battery_life !== undefined) {
                    // Convert the battery_life value to a number
                    const batteryLife = parseFloat(intercom.battery_life);
                    const batteryService = acc.addService(hap.Service.Battery, `${this.name} Battery`);

                    // Initialize Battery Characteristics
                    batteryService.getCharacteristic(hap.Characteristic.BatteryLevel).updateValue(batteryLife);
                    const statusLow = batteryLife < 20 ? hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW : hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL;
                    batteryService.getCharacteristic(hap.Characteristic.StatusLowBattery).updateValue(statusLow);
                }

                acc.isConfigured = true;
            }

            this.setupCharacteristics(acc, hap, intercom);
        }

        setupCharacteristics(acc, hap, intercom) {
            let unlocking = false;
            let unlockTimeout = null;
            let initialized = false;

            const lockService = acc.getService(hap.Service.LockMechanism);
            const doorbellService = acc.getService(hap.Service.StatelessProgrammableSwitch);
            const batteryService = acc.getService(hap.Service.Battery);

            // Synchronize Lock State
            const syncLockState = () => {
                const state = unlocking ? hap.Characteristic.LockCurrentState.UNSECURED : hap.Characteristic.LockCurrentState.SECURED;
                lockService.getCharacteristic(hap.Characteristic.LockCurrentState).updateValue(state);
                lockService.getCharacteristic(hap.Characteristic.LockTargetState).updateValue(state);
            };

            // Handle Unlocking Logic
            const markAsUnlocked = () => {
                console.log(`Marking ${this.name} as unlocked.`);
                clearTimeout(unlockTimeout);
                unlocking = true;
                syncLockState();

                unlockTimeout = setTimeout(() => {
                    unlocking = false;
                    syncLockState();
                    console.log(`${this.name} has been locked again after timeout.`);
                    unlockTimeout = null;
                }, 3000); // Ensure this matches the desired timeout duration
            };

            // Subscribe to Intercom's Unlocked Event
            intercom.onUnlocked.subscribe(() => {
                if (initialized) { 
                    markAsUnlocked();
                }
            });

            // Lock Service - LockTargetState Set Handler
            lockService.getCharacteristic(hap.Characteristic.LockTargetState)
                .on('set', async (value, callback) => {
                    // Ensure callback is called only once
                    let called = false;
                    const safeCallback = (err, res) => {
                        if (!called) {
                            called = true;
                            callback(err, res);
                        }
                    };

                    try {
                        // Clear any existing unlock timeout
                        if (unlockTimeout) {
                            clearTimeout(unlockTimeout);
                            unlockTimeout = null;
                        }

                        if (value === hap.Characteristic.LockTargetState.UNSECURED) {
                            console.log(`Unlocking ${this.name}`);
                            unlocking = true;

                            const response = await intercom.unlock();
                            console.log(`Unlock response for ${this.name}: ${JSON.stringify(response)}`);
                            markAsUnlocked();
                            this.emit('unlocked'); // Emit event instead of using send
                            safeCallback(null);
                        } else {
                            // If the user locks the door from the home app, set the states back to "locked"
                            unlocking = false;
                            syncLockState();
                            console.log(`Locking ${this.name}`);
                            safeCallback(null);
                        }
                    } catch (error) {
                        console.error(`Error unlocking ${this.name}:`, error);
                        unlocking = false;
                        safeCallback(error);
                    }
                });

            // Lock Service - LockCurrentState Get Handler
            lockService.getCharacteristic(hap.Characteristic.LockCurrentState)
                .on('get', (callback) => {
                    try {
                        const state = unlocking ? hap.Characteristic.LockCurrentState.UNSECURED : hap.Characteristic.LockCurrentState.SECURED;
                        callback(null, state);
                    } catch (error) {
                        console.error(`Error getting current state for ${this.name}:`, error);
                        callback(error);
                    }
                });

            // Subscribe to Doorbell Events
            intercom.onDing.pipe(
                throttleTime(15000),
                map(() => hap.Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS)
            ).subscribe({
                next: () => {
                    try {
                        doorbellService.getCharacteristic(hap.Characteristic.ProgrammableSwitchEvent)
                            .updateValue(hap.Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS);
                        this.emit('doorbell_pressed'); // Emit event instead of using send
                    } catch (error) {
                        console.error(`Error handling doorbell press for ${this.name}:`, error);
                    }
                },
                error: (err) => {
                    console.error(`Error in doorbell subscription for ${this.name}:`, err);
                }
            });

            // Handle Battery Level if applicable
            if (batteryService && intercom.battery_life !== null && intercom.battery_life !== undefined) {
                const updateBatteryLevel = (batteryLevel) => {
                    try {
                        const level = batteryLevel === null ? 100 : batteryLevel;
                        batteryService.getCharacteristic(hap.Characteristic.BatteryLevel).updateValue(level);
                        const statusLow = level < 20 ? hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW : hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL;
                        batteryService.getCharacteristic(hap.Characteristic.StatusLowBattery).updateValue(statusLow);
                    } catch (error) {
                        console.error(`Error updating battery level for ${this.name}:`, error);
                    }
                };

                updateBatteryLevel(intercom.battery_life);
                intercom.onBatteryLevel.subscribe({
                    next: updateBatteryLevel,
                    error: (err) => {
                        console.error(`Error in battery level subscription for ${this.name}:`, err);
                    }
                });
            }

            // Synchronize initial lock state
            syncLockState();

            // Mark initialization as complete
            initialized = true;
        }
    }        

    // Initialize Ring API, fetch devices, and create intercom instances
    function RedMaticHomeKitRingIntercom(config) {
        RED.nodes.createNode(this, config);
        const node = this; // Preserve context

        this.ringConfig = RED.nodes.getNode(config.ringConfig);
        if (!this.ringConfig || !this.ringConfig.credentials || !this.ringConfig.credentials.refreshToken) {
            node.error('Missing Ring API configuration or refresh token');
            return;
        }

        const ringApi = new RingApi({
            refreshToken: this.ringConfig.credentials.refreshToken,
            debug: config.debug,
        });

        const getDevices = async () => {
            try {
                const locations = await ringApi.getLocations();
                console.log("Locations: ", locations);

                locations.forEach(location => {
                    const { intercoms } = location;

                    if (!intercoms || intercoms.length === 0) {
                        console.error(`No Intercom device found in location: ${location.locationDetails.name}`);
                        return;
                    }

                    console.log("Intercoms:", intercoms);
                    intercoms.forEach(intercom => {
                        if (intercom) {
                            const device = new RedMaticHomeKitRingDevice(config, intercom); 
                            
                            // Listen to device events and send messages accordingly
                            device.on('unlocked', () => {
                                node.send({ payload: 'unlocked', device: device.name });
                            });

                            device.on('doorbell_pressed', () => {
                                node.send({ payload: 'doorbell_pressed', device: device.name });
                            });
                        }
                    });
                });
            } catch (error) {
                console.error('Failed to retrieve Ring devices:', error);
                node.error('Failed to retrieve Ring devices');
            }
        };

        getDevices();

        // Optional: Implement polling or event-based updates if needed
    }

    RED.nodes.registerType('redmatic-homekit-ring-intercom', RedMaticHomeKitRingIntercom);
};
