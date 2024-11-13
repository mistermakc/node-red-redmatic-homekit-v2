module.exports = function (RED) {
    // Config node to hold the Ring refresh token
    function RingConfigNode(config) {
        RED.nodes.createNode(this, config);
        this.name = config.name;
        this.refreshToken = this.credentials.refreshToken;
    }
    RED.nodes.registerType('redmatic-homekit-ring-config', RingConfigNode, {
        credentials: {
            refreshToken: { type: 'text' }
        }
    });
};
