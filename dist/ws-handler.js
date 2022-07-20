"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WsHandler = void 0;
const async_1 = require("async");
const channels_1 = require("./channels");
const log_1 = require("./log");
const channels_2 = require("./channels");
const channels_3 = require("./channels");
const channels_4 = require("./channels");
const utils_1 = require("./utils");
const ab2str = require('arraybuffer-to-string');
const Pusher = require('pusher');
class WsHandler {
    constructor(server) {
        this.server = server;
        this.publicChannelManager = new channels_4.PublicChannelManager(server);
        this.privateChannelManager = new channels_3.PrivateChannelManager(server);
        this.encryptedPrivateChannelManager = new channels_1.EncryptedPrivateChannelManager(server);
        this.presenceChannelManager = new channels_2.PresenceChannelManager(server);
    }
    onOpen(ws) {
        if (this.server.options.debug) {
            log_1.Log.websocketTitle('👨‍🔬 New connection:');
            log_1.Log.websocket({ ws });
        }
        ws.sendJson = (data) => {
            try {
                ws.send(JSON.stringify(data));
                this.updateTimeout(ws);
                if (ws.app) {
                    this.server.metricsManager.markWsMessageSent(ws.app.id, data);
                }
                if (this.server.options.debug) {
                    log_1.Log.websocketTitle('✈ Sent message to client:');
                    log_1.Log.websocket({ ws, data });
                }
            }
            catch (e) {
            }
        };
        ws.id = this.generateSocketId();
        ws.subscribedChannels = new Set();
        ws.presence = new Map();
        if (this.server.closing) {
            ws.sendJson({
                event: 'pusher:error',
                data: {
                    code: 4200,
                    message: 'Server is closing. Please reconnect shortly.',
                },
            });
            return ws.end(4200);
        }
        this.checkForValidApp(ws).then(validApp => {
            if (!validApp) {
                ws.sendJson({
                    event: 'pusher:error',
                    data: {
                        code: 4001,
                        message: `App key ${ws.appKey} does not exist.`,
                    },
                });
                return ws.end(4001);
            }
            ws.app = validApp.forWebSocket();
            this.checkIfAppIsEnabled(ws).then(enabled => {
                if (!enabled) {
                    ws.sendJson({
                        event: 'pusher:error',
                        data: {
                            code: 4003,
                            message: 'The app is not enabled.',
                        },
                    });
                    return ws.end(4003);
                }
                this.checkAppConnectionLimit(ws).then(canConnect => {
                    if (!canConnect) {
                        ws.sendJson({
                            event: 'pusher:error',
                            data: {
                                code: 4100,
                                message: 'The current concurrent connections quota has been reached.',
                            },
                        });
                        ws.end(4100);
                    }
                    else {
                        this.server.adapter.addSocket(ws.app.id, ws);
                        let broadcastMessage = {
                            event: 'pusher:connection_established',
                            data: JSON.stringify({
                                socket_id: ws.id,
                                activity_timeout: 30,
                            }),
                        };
                        ws.sendJson(broadcastMessage);
                        if (ws.app.enableUserAuthentication) {
                            this.setUserAuthenticationTimeout(ws);
                        }
                        this.server.metricsManager.markNewConnection(ws);
                    }
                });
            });
        });
    }
    onMessage(ws, message, isBinary) {
        if (message instanceof ArrayBuffer) {
            try {
                message = JSON.parse(ab2str(message));
            }
            catch (err) {
                return;
            }
        }
        if (this.server.options.debug) {
            log_1.Log.websocketTitle('⚡ New message received:');
            log_1.Log.websocket({ message, isBinary });
        }
        if (message) {
            if (message.event === 'pusher:ping') {
                this.handlePong(ws);
            }
            else if (message.event === 'pusher:subscribe') {
                this.subscribeToChannel(ws, message);
            }
            else if (message.event === 'pusher:unsubscribe') {
                this.unsubscribeFromChannel(ws, message.data.channel);
            }
            else if (utils_1.Utils.isClientEvent(message.event)) {
                this.handleClientEvent(ws, message);
            }
            else if (message.event === 'pusher:signin') {
                this.handleSignin(ws, message);
            }
            else {
                log_1.Log.warning({
                    info: 'Message event handler not implemented.',
                    message,
                });
            }
        }
        if (ws.app) {
            this.server.metricsManager.markWsMessageReceived(ws.app.id, message);
        }
    }
    onClose(ws, code, message) {
        if (this.server.options.debug) {
            log_1.Log.websocketTitle('❌ Connection closed:');
            log_1.Log.websocket({ ws, code, message });
        }
        if (code !== 4200) {
            this.evictSocketFromMemory(ws);
        }
    }
    evictSocketFromMemory(ws) {
        return this.unsubscribeFromAllChannels(ws, true).then(() => {
            if (ws.app) {
                this.server.adapter.removeSocket(ws.app.id, ws.id);
                this.server.metricsManager.markDisconnection(ws);
            }
            this.clearTimeout(ws);
        });
    }
    async closeAllLocalSockets() {
        let namespaces = this.server.adapter.getNamespaces();
        if (namespaces.size === 0) {
            return Promise.resolve();
        }
        return async_1.default.each([...namespaces], ([namespaceId, namespace], nsCallback) => {
            namespace.getSockets().then(sockets => {
                async_1.default.each([...sockets], ([wsId, ws], wsCallback) => {
                    try {
                        ws.sendJson({
                            event: 'pusher:error',
                            data: {
                                code: 4200,
                                message: 'Server closed. Please reconnect shortly.',
                            },
                        });
                        ws.end(4200);
                    }
                    catch (e) {
                    }
                    this.evictSocketFromMemory(ws).then(() => {
                        wsCallback();
                    });
                }).then(() => {
                    this.server.adapter.clearNamespace(namespaceId).then(() => {
                        nsCallback();
                    });
                });
            });
        }).then(() => {
            return this.server.adapter.clearNamespaces();
        });
    }
    handleUpgrade(res, req, context) {
        res.upgrade({
            ip: ab2str(res.getRemoteAddressAsText()),
            ip2: ab2str(res.getProxiedRemoteAddressAsText()),
            appKey: req.getParameter(0),
        }, req.getHeader('sec-websocket-key'), req.getHeader('sec-websocket-protocol'), req.getHeader('sec-websocket-extensions'), context);
    }
    handlePong(ws) {
        ws.sendJson({
            event: 'pusher:pong',
            data: {},
        });
        if (this.server.closing) {
            ws.sendJson({
                event: 'pusher:error',
                data: {
                    code: 4200,
                    message: 'Server closed. Please reconnect shortly.',
                },
            });
            ws.end(4200);
            this.evictSocketFromMemory(ws);
        }
    }
    subscribeToChannel(ws, message) {
        if (this.server.closing) {
            ws.sendJson({
                event: 'pusher:error',
                data: {
                    code: 4200,
                    message: 'Server closed. Please reconnect shortly.',
                },
            });
            ws.end(4200);
            this.evictSocketFromMemory(ws);
            return;
        }
        let channel = message.data.channel;
        let channelManager = this.getChannelManagerFor(channel);
        if (channel.length > ws.app.maxChannelNameLength) {
            let broadcastMessage = {
                event: 'pusher:subscription_error',
                channel,
                data: {
                    type: 'LimitReached',
                    error: `The channel name is longer than the allowed ${ws.app.maxChannelNameLength} characters.`,
                    status: 4009,
                },
            };
            ws.sendJson(broadcastMessage);
            return;
        }
        channelManager.join(ws, channel, message).then((response) => {
            if (!response.success) {
                let { authError, type, errorMessage, errorCode } = response;
                if (authError) {
                    return ws.sendJson({
                        event: 'pusher:subscription_error',
                        channel,
                        data: {
                            type: 'AuthError',
                            error: errorMessage,
                            status: 401,
                        },
                    });
                }
                return ws.sendJson({
                    event: 'pusher:subscription_error',
                    channel,
                    data: {
                        type: type,
                        error: errorMessage,
                        status: errorCode,
                    },
                });
            }
            if (!ws.subscribedChannels.has(channel)) {
                ws.subscribedChannels.add(channel);
            }
            this.server.adapter.addSocket(ws.app.id, ws);
            if (response.channelConnections === 1) {
                this.server.webhookSender.sendChannelOccupied(ws.app, channel);
            }
            if (!(channelManager instanceof channels_2.PresenceChannelManager)) {
                let broadcastMessage = {
                    event: 'pusher_internal:subscription_succeeded',
                    channel,
                };
                ws.sendJson(broadcastMessage);
                if (utils_1.Utils.isCachingChannel(channel)) {
                    this.sendMissedCacheIfExists(ws, channel);
                }
                return;
            }
            this.server.adapter.getChannelMembers(ws.app.id, channel, false).then(members => {
                let { user_id, user_info } = response.member;
                ws.presence.set(channel, response.member);
                this.server.adapter.addSocket(ws.app.id, ws);
                if (!members.has(user_id)) {
                    this.server.webhookSender.sendMemberAdded(ws.app, channel, user_id);
                    this.server.adapter.send(ws.app.id, channel, JSON.stringify({
                        event: 'pusher_internal:member_added',
                        channel,
                        data: JSON.stringify({
                            user_id: user_id,
                            user_info: user_info,
                        }),
                    }), ws.id);
                    members.set(user_id, user_info);
                }
                let broadcastMessage = {
                    event: 'pusher_internal:subscription_succeeded',
                    channel,
                    data: JSON.stringify({
                        presence: {
                            ids: Array.from(members.keys()),
                            hash: Object.fromEntries(members),
                            count: members.size,
                        },
                    }),
                };
                ws.sendJson(broadcastMessage);
                if (utils_1.Utils.isCachingChannel(channel)) {
                    this.sendMissedCacheIfExists(ws, channel);
                }
            }).catch(err => {
                log_1.Log.error(err);
                ws.sendJson({
                    event: 'pusher:error',
                    channel,
                    data: {
                        type: 'ServerError',
                        error: 'A server error has occured.',
                        code: 4302,
                    },
                });
            });
        });
    }
    unsubscribeFromChannel(ws, channel, closing = false) {
        let channelManager = this.getChannelManagerFor(channel);
        return channelManager.leave(ws, channel).then(response => {
            let member = ws.presence.get(channel);
            if (response.left) {
                if (channelManager instanceof channels_2.PresenceChannelManager && ws.presence.has(channel)) {
                    ws.presence.delete(channel);
                    this.server.adapter.addSocket(ws.app.id, ws);
                    this.server.adapter.getChannelMembers(ws.app.id, channel, false).then(members => {
                        if (!members.has(member.user_id)) {
                            this.server.webhookSender.sendMemberRemoved(ws.app, channel, member.user_id);
                            this.server.adapter.send(ws.app.id, channel, JSON.stringify({
                                event: 'pusher_internal:member_removed',
                                channel,
                                data: JSON.stringify({
                                    user_id: member.user_id,
                                }),
                            }), ws.id);
                        }
                    });
                }
                ws.subscribedChannels.delete(channel);
                if (!closing) {
                    this.server.adapter.addSocket(ws.app.id, ws);
                }
                if (response.remainingConnections === 0) {
                    this.server.webhookSender.sendChannelVacated(ws.app, channel);
                }
            }
            return;
        });
    }
    unsubscribeFromAllChannels(ws, closing = true) {
        if (!ws.subscribedChannels) {
            return Promise.resolve();
        }
        return Promise.all([
            async_1.default.each(ws.subscribedChannels, (channel, callback) => {
                this.unsubscribeFromChannel(ws, channel, closing).then(() => callback());
            }),
            ws.app && ws.user ? this.server.adapter.removeUser(ws) : new Promise(resolve => resolve()),
        ]).then(() => {
            return;
        });
    }
    handleClientEvent(ws, message) {
        let { event, data, channel } = message;
        if (!ws.app.enableClientMessages) {
            return ws.sendJson({
                event: 'pusher:error',
                channel,
                data: {
                    code: 4301,
                    message: `The app does not have client messaging enabled.`,
                },
            });
        }
        if (event.length > ws.app.maxEventNameLength) {
            let broadcastMessage = {
                event: 'pusher:error',
                channel,
                data: {
                    code: 4301,
                    message: `Event name is too long. Maximum allowed size is ${ws.app.maxEventNameLength}.`,
                },
            };
            ws.sendJson(broadcastMessage);
            return;
        }
        let payloadSizeInKb = utils_1.Utils.dataToKilobytes(message.data);
        if (payloadSizeInKb > parseFloat(ws.app.maxEventPayloadInKb)) {
            let broadcastMessage = {
                event: 'pusher:error',
                channel,
                data: {
                    code: 4301,
                    message: `The event data should be less than ${ws.app.maxEventPayloadInKb} KB.`,
                },
            };
            ws.sendJson(broadcastMessage);
            return;
        }
        this.server.adapter.isInChannel(ws.app.id, channel, ws.id).then(canBroadcast => {
            if (!canBroadcast) {
                return;
            }
            this.server.rateLimiter.consumeFrontendEventPoints(1, ws.app, ws).then(response => {
                if (response.canContinue) {
                    let userId = ws.presence.has(channel) ? ws.presence.get(channel).user_id : null;
                    let message = JSON.stringify({
                        event,
                        channel,
                        data,
                        ...userId ? { user_id: userId } : {},
                    });
                    this.server.adapter.send(ws.app.id, channel, message, ws.id);
                    this.server.webhookSender.sendClientEvent(ws.app, channel, event, data, ws.id, userId);
                    return;
                }
                ws.sendJson({
                    event: 'pusher:error',
                    channel,
                    data: {
                        code: 4301,
                        message: 'The rate limit for sending client events exceeded the quota.',
                    },
                });
            });
        });
    }
    handleSignin(ws, message) {
        if (!ws.userAuthenticationTimeout) {
            return;
        }
        this.signinTokenIsValid(ws, message.data.user_data, message.data.auth).then(isValid => {
            if (!isValid) {
                ws.sendJson({
                    event: 'pusher:error',
                    data: {
                        code: 4009,
                        message: 'Connection not authorized.',
                    },
                });
                try {
                    ws.end(4009);
                }
                catch (e) {
                }
                return;
            }
            let decodedUser = JSON.parse(message.data.user_data);
            if (!decodedUser.id) {
                ws.sendJson({
                    event: 'pusher:error',
                    data: {
                        code: 4009,
                        message: 'The returned user data must contain the "id" field.',
                    },
                });
                try {
                    ws.end(4009);
                }
                catch (e) {
                }
                return;
            }
            ws.user = {
                ...decodedUser,
                ...{
                    id: decodedUser.id.toString(),
                },
            };
            if (ws.userAuthenticationTimeout) {
                clearTimeout(ws.userAuthenticationTimeout);
            }
            this.server.adapter.addSocket(ws.app.id, ws);
            this.server.adapter.addUser(ws).then(() => {
                ws.sendJson({
                    event: 'pusher:signin_success',
                    data: message.data,
                });
            });
        });
    }
    sendMissedCacheIfExists(ws, channel) {
        this.server.cacheManager.get(`app:${ws.app.id}:channel:${channel}:cache_miss`).then(cachedEvent => {
            if (cachedEvent) {
                ws.sendJson({ event: 'pusher:cache_miss', channel, data: cachedEvent });
            }
            else {
                this.server.webhookSender.sendCacheMissed(ws.app, channel);
            }
        });
    }
    getChannelManagerFor(channel) {
        if (utils_1.Utils.isPresenceChannel(channel)) {
            return this.presenceChannelManager;
        }
        else if (utils_1.Utils.isEncryptedPrivateChannel(channel)) {
            return this.encryptedPrivateChannelManager;
        }
        else if (utils_1.Utils.isPrivateChannel(channel)) {
            return this.privateChannelManager;
        }
        else {
            return this.publicChannelManager;
        }
    }
    checkForValidApp(ws) {
        return this.server.appManager.findByKey(ws.appKey);
    }
    checkIfAppIsEnabled(ws) {
        return Promise.resolve(ws.app.enabled);
    }
    checkAppConnectionLimit(ws) {
        return this.server.adapter.getSocketsCount(ws.app.id).then(wsCount => {
            let maxConnections = parseInt(ws.app.maxConnections) || -1;
            if (maxConnections < 0) {
                return true;
            }
            return wsCount + 1 <= maxConnections;
        }).catch(err => {
            log_1.Log.error(err);
            return false;
        });
    }
    signinTokenIsValid(ws, userData, signatureToCheck) {
        return this.signinTokenForUserData(ws, userData).then(expectedSignature => {
            return signatureToCheck === expectedSignature;
        });
    }
    signinTokenForUserData(ws, userData) {
        return new Promise(resolve => {
            let decodedString = `${ws.id}::user::${userData}`;
            let token = new Pusher.Token(ws.app.key, ws.app.secret);
            resolve(ws.app.key + ':' + token.sign(decodedString));
        });
    }
    generateSocketId() {
        let min = 0;
        let max = 10000000000;
        let randomNumber = (min, max) => Math.floor(Math.random() * (max - min + 1) + min);
        return randomNumber(min, max) + '.' + randomNumber(min, max);
    }
    clearTimeout(ws) {
        if (ws.timeout) {
            clearTimeout(ws.timeout);
        }
    }
    updateTimeout(ws) {
        this.clearTimeout(ws);
        ws.timeout = setTimeout(() => {
            ws.end(4201);
        }, 120000);
    }
    setUserAuthenticationTimeout(ws) {
        ws.userAuthenticationTimeout = setTimeout(() => {
            ws.sendJson({
                event: 'pusher:error',
                data: {
                    code: 4009,
                    message: 'Connection not authorized within timeout.',
                },
            });
            try {
                ws.end(4009);
            }
            catch (e) {
            }
        }, this.server.options.userAuthenticationTimeout);
    }
}
exports.WsHandler = WsHandler;
