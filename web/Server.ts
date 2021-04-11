/*  nodejs-poolController.  An application to control pool equipment.
Copyright (C) 2016, 2017, 2018, 2019, 2020.  Russell Goldin, tagyoureit.  russ.goldin@gmail.com

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program.  If not, see <http://www.gnu.org/licenses/>.
*/
import * as path from "path";
import * as fs from "fs";
import express = require('express');
import { utils } from "../controller/Constants";
import { config } from "../config/Config";
import { logger } from "../logger/Logger";
import { Namespace, RemoteSocket, Server as SocketIoServer, Socket } from "socket.io";
import { io as sockClient } from "socket.io-client";
import { ConfigRoute } from "./services/config/Config";
import { StateRoute } from "./services/state/State";
import { StateSocket } from "./services/state/StateSocket";
import { UtilitiesRoute } from "./services/utilities/Utilities";
import * as http2 from "http2";
import * as http from "http";
import * as https from "https";
import { state } from "../controller/State";
import { conn } from "../controller/comms/Comms";
import { Inbound, Outbound } from "../controller/comms/messages/Messages";
import { EventEmitter } from 'events';
import { sys } from '../controller/Equipment';
import * as multicastdns from 'multicast-dns';
import * as ssdp from 'node-ssdp';
import * as os from 'os';
import { URL } from "url";
import { HttpInterfaceBindings } from './interfaces/httpInterface';
import { InfluxInterfaceBindings } from './interfaces/influxInterface';
import { MqttInterfaceBindings } from './interfaces/mqttInterface';
import { Timestamp } from '../controller/Constants';
import extend = require("extend");
import { ConfigSocket } from "./services/config/ConfigSocket";


// This class serves data and pages for
// external interfaces as well as an internal dashboard.
export class WebServer {
    private _servers: ProtoServer[] = [];
    private family = 'IPv4';
    constructor() { }
    public init() {
        let cfg = config.getSection('web');
        let srv;
        for (let s in cfg.servers) {
            let c = cfg.servers[s];
            if (typeof c.uuid === 'undefined') {
                c.uuid = utils.uuid();
                config.setSection(`web.servers.${s}`, c);
            }
            switch (s) {
                case 'http':
                    srv = new HttpServer(s, s);
                    break;
                case 'http2':
                    srv = new Http2Server(s, s);
                    break;
                case 'https':
                    srv = new HttpsServer(s, s);
                    break;
                case 'mdns':
                    srv = new MdnsServer(s, s);
                    break;
                case 'ssdp':
                    srv = new SsdpServer(s, s);
                    break;
            }
            if (typeof srv !== 'undefined') {
                this._servers.push(srv);
                srv.init(c);
                srv = undefined;
            }
        }
        this.initInterfaces(cfg.interfaces);
    }
    public initInterfaces(interfaces: any) {
        for (let s in interfaces) {
            let int;
            let c = interfaces[s];
            if (typeof c.uuid === 'undefined') {
                c.uuid = utils.uuid();
                config.setSection(`web.interfaces.${s}`, c);
            }
            if (!c.enabled) continue;
            let type = c.type || 'http';
            logger.info(`Init ${type} interface: ${c.name}`);
            switch (type) {
                case 'http':
                    int = new HttpInterfaceServer(c.name, type);
                    int.init(c);
                    this._servers.push(int);
                    break;
                case 'influx':
                    int = new InfluxInterfaceServer(c.name, type);
                    int.init(c);
                    this._servers.push(int);
                    break;
                case 'mqtt':
                    int = new MqttInterfaceServer(c.name, type);
                    int.init(c);
                    this._servers.push(int);
                    break;
                case 'rem':
                    int = new REMInterfaceServer(c.name, type);
                    int.init(c);
                    this._servers.push(int);
                    break;
            }
        }
    }
    public emitToClients(evt: string, ...data: any) {
        for (let i = 0; i < this._servers.length; i++) {
            this._servers[i].emitToClients(evt, ...data);
        }
    }
    public emitToChannel(channel: string, evt: string, ...data: any) {
        for (let i = 0; i < this._servers.length; i++) {
            this._servers[i].emitToChannel(channel, evt, ...data);
        }
    }
    public get mdnsServer(): MdnsServer { return this._servers.find(elem => elem instanceof MdnsServer) as MdnsServer; }
    public deviceXML() { } // override in SSDP
    public async stopAsync() {
        try {
            // We want to stop all the servers in reverse order so let's pop them out.
            for (let s in this._servers) {
                try {
                    let serv = this._servers[s];
                    if (typeof serv.stopAsync === 'function') {
                        await serv.stopAsync();
                    }
                    this._servers[s] = undefined;
                } catch (err) { console.log(`Error stopping server ${s}: ${err.message}`); }
            }
        } catch (err) { `Error stopping servers` }
    }
    private getInterface() {
        const networkInterfaces = os.networkInterfaces();
        // RKS: We need to get the scope-local nic. This has nothing to do with IP4/6 and is not necessarily named en0 or specific to a particular nic.  We are
        // looking for the first IPv4 interface that has a mac address which will be the scope-local address.  However, in the future we can simply use the IPv6 interface
        // if that is returned on the local scope but I don't know if the node ssdp server supports it on all platforms.
        for (let name in networkInterfaces) {
            let nic = networkInterfaces[name];
            for (let ndx in nic) {
                let addr = nic[ndx];
                // All scope-local addresses will have a mac.  In a multi-nic scenario we are simply grabbing
                // the first one we come across.
                if (!addr.internal && addr.mac.indexOf('00:00:00:') < 0 && addr.family === this.family) {
                    return addr;
                }
            }
        }
    }
    public ip() {
        return typeof this.getInterface() === 'undefined' ? '0.0.0.0' : this.getInterface().address;
    }
    public mac() {
        return typeof this.getInterface() === 'undefined' ? '00:00:00:00' : this.getInterface().mac;
    }
    public findServer(name: string): ProtoServer { return this._servers.find(elem => elem.name === name); }
    public findServersByType(type: string) { return this._servers.filter(elem => elem.type === type); }
    public findServerByGuid(uuid: string) { return this._servers.find(elem => elem.uuid === uuid); }
    public removeServerByGuid(uuid: string) {
        for (let i = 0; i < this._servers.length; i++) {
            if (this._servers[i].uuid === uuid) this._servers.splice(i, 1);
        }
    }
    public async updateServerInterface(obj: any) {
        let int = config.setInterface(obj);
        let srv = this.findServerByGuid(obj.uuid);
        // if server is not enabled; stop & remove it from local storage
        if (typeof srv !== 'undefined') {
            await srv.stopAsync();
            this.removeServerByGuid(obj.uuid);
        }
        // if it's enabled, restart it or initialize it
        if (obj.enabled) {
            if (typeof srv === 'undefined') {
                this.initInterfaces(int);
            }
            else srv.init(obj);
        }
    }
}
class ProtoServer {
    constructor(name: string, type: string) { this.name = name; this.type = type; }
    public name: string;
    public type: string;
    public uuid: string;
    public remoteConnectionId: string;
    // base class for all servers.
    public isRunning: boolean = false;
    public get isConnected() { return this.isRunning; }
    public emitToClients(evt: string, ...data: any) { }
    public emitToChannel(channel: string, evt: string, ...data: any) { }
    public init(obj: any) { };
    public async stopAsync() { }
    protected _dev: boolean = process.env.NODE_ENV !== 'production';
    // todo: how do we know if the client is using IPv4/IPv6?
}
export class Http2Server extends ProtoServer {
    public server: http2.Http2Server;
    public app: Express.Application;
    public init(cfg) {
        this.uuid = cfg.uuid;
        if (cfg.enabled) {
            this.app = express();
            // TODO: create a key and cert at some time but for now don't fart with it.
        }
    }
}
interface ClientToServerEvents {
    noArg: () => void;
    basicEmit: (a: number, b: string, c: number[]) => void;
}

interface ServerToClientEvents {
    withAck: (d: string, cb: (e: number) => void) => void;
}
export class HttpServer extends ProtoServer {
    // Http protocol
    public app: express.Application;
    public server: http.Server;
    public sockServer: SocketIoServer<ClientToServerEvents, ServerToClientEvents>;
    private _nameSpace: Namespace;
    private _sockets: RemoteSocket<ServerToClientEvents>[] = [];
    public emitToClients(evt: string, ...data: any) {
        if (this.isRunning) {
            this._nameSpace.emit(evt, ...data);
        }
    }
    public emitToChannel(channel: string, evt: string, ...data: any) {
        //console.log(`Emitting to channel ${channel} - ${evt}`)
        if (this.isRunning) {
            let _nameSpace: Namespace = this.sockServer.of(channel);
            _nameSpace.emit(evt, ...data);
        }
    }
    public get isConnected() { return typeof this.sockServer !== 'undefined' && this._sockets.length > 0; }
    protected initSockets() {
        let options = {
            allowEIO3: true,
            cors: {
                origin: true,
                methods: ["GET", "POST"],
                credentials: true
            }
        }
        this.sockServer = new SocketIoServer(this.server, options);
        this._nameSpace = this.sockServer.of('/');
        this.sockServer.on("connection", (sock: Socket) => {
            logger.info(`New socket client connected ${sock.id} -- ${sock.client.conn.remoteAddress}`);
            this.socketHandler(sock);
            sock.emit('controller', state.controllerState);
            sock.conn.emit('controller', state.controllerState); // do we need both of these?
            //this.sockServer.origins('*:*');
            sock.on('connect_error', (err) => {
                logger.error('Socket server error %s', err.message);
            });
            sock.on('reconnect_failed', (err) => {
                logger.error('Failed to reconnect with socket %s', err.message);
            });
        });
        this.app.use('/socket.io-client', express.static(path.join(process.cwd(), '/node_modules/socket.io-client/dist/'), { maxAge: '60d' }));
    }

    private socketHandler(sock: Socket) {
        let self = this;
        // this._sockets.push(sock);
        setTimeout(async () => {
            // refresh socket list with every new socket
            self._sockets = await self.sockServer.fetchSockets();
        }, 100)

        sock.on('error', (err) => {
            logger.error('Error with socket: %s', err);
        });
        sock.on('close', async (id) => {
            logger.info('Socket diconnecting %s', id);
            self._sockets = await self.sockServer.fetchSockets();
        });
        sock.on('echo', (msg) => { sock.emit('echo', msg); });
        sock.on('receivePacketRaw', function (incomingPacket: any[]) {
            //var str = 'Add packet(s) to incoming buffer: ';
            logger.silly('User request (replay.html) to RECEIVE packet: %s', JSON.stringify(incomingPacket));
            for (var i = 0; i < incomingPacket.length; i++) {
                conn.buffer.pushIn(Buffer.from(incomingPacket[i]));
                // str += JSON.stringify(incomingPacket[i]) + ' ';
            }
            //logger.info(str);
        });
        sock.on('replayPackets', function (inboundPkts: number[][]) {
            // used for replay
            logger.debug(`Received replayPackets: ${inboundPkts}`);
            inboundPkts.forEach(inbound => {
                conn.buffer.pushIn(Buffer.from([].concat.apply([], inbound)));
                // conn.queueInboundMessage([].concat.apply([], inbound));
            });
        });
        sock.on('sendPackets', function (bytesToProcessArr: number[][]) {
            // takes an input of bytes (src/dest/action/payload) and sends
            if (!bytesToProcessArr.length) return;
            logger.silly('User request (replay.html) to SEND packet: %s', JSON.stringify(bytesToProcessArr));

            do {
                let bytesToProcess: number[] = bytesToProcessArr.shift();

                // todo: logic for chlor packets
                let out = Outbound.create({
                    source: bytesToProcess.shift(),
                    dest: bytesToProcess.shift(),
                    action: bytesToProcess.shift(),
                    payload: bytesToProcess.splice(1, bytesToProcess[0])
                });
                conn.queueSendMessage(out);
            } while (bytesToProcessArr.length > 0);

        });
        sock.on('sendOutboundMessage', (mdata) => {
            let msg: Outbound = Outbound.create({});
            Object.assign(msg, mdata);
            msg.calcChecksum();
            logger.silly(`sendOutboundMessage ${msg.toLog()}`);
            conn.queueSendMessage(msg);
        });
        sock.on('sendLogMessages', function (sendMessages: boolean) {
            console.log(`sendLogMessages set to ${sendMessages}`);
            if (!sendMessages) sock.leave('msgLogger');
            else sock.join('msgLogger');
        });
        StateSocket.initSockets(sock);
        ConfigSocket.initSockets(sock);
    }
    public init(cfg) {
        this.uuid = cfg.uuid;
        if (cfg.enabled) {
            this.app = express();

            //this.app.use();
            this.server = http.createServer(this.app);
            if (cfg.httpsRedirect) {
                var cfgHttps = config.getSection('web').server.https;
                this.app.get('*', (res: express.Response, req: express.Request) => {
                    let host = res.get('host');
                    // Only append a port if there is one declared.  This will be the case for urls that have have an implicit port.
                    host = host.replace(/:\d+$/, typeof cfgHttps.port !== 'undefined' ? ':' + cfgHttps.port : '');
                    return res.redirect('https://' + host + req.url);
                });
            }
            this.app.use(express.json());
            this.app.use((req, res, next) => {
                res.header('Access-Control-Allow-Origin', '*');
                res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, api_key, Authorization'); // api_key and Authorization needed for Swagger editor live API document calls
                res.header('Access-Control-Allow-Methods', 'OPTIONS, GET, POST, PUT, DELETE');
                if ('OPTIONS' === req.method) { res.sendStatus(200); }
                else {
                    if (req.url !== '/device') {
                        logger.info(`[${new Date().toLocaleTimeString()}] ${req.ip} ${req.method} ${req.url} ${typeof req.body === 'undefined' ? '' : JSON.stringify(req.body)}`);
                        logger.logAPI(`{"dir":"in","proto":"api","requestor":"${req.ip}","method":"${req.method}","path":"${req.url}",${typeof req.body === 'undefined' ? '' : `"body":${JSON.stringify(req.body)},`}"ts":"${Timestamp.toISOLocal(new Date())}"}${os.EOL}`);
                    }
                    next();
                }
            });


            // Put in a custom replacer so that we can send error messages to the client.  If we don't do this the base properties of Error
            // are omitted from the output.
            this.app.set('json replacer', (key, value) => {
                if (value instanceof Error) {
                    var err = {};
                    Object.getOwnPropertyNames(value).forEach((prop) => {
                        if (prop === "level") err[prop] = value[prop].replace(/\x1b\[\d{2}m/g, '') // remove color from level
                        else err[prop] = value[prop];
                    });
                    return err;
                }
                return value;
            });

            ConfigRoute.initRoutes(this.app);
            StateRoute.initRoutes(this.app);
            UtilitiesRoute.initRoutes(this.app);

            // The socket initialization needs to occur before we start listening.  If we don't then
            // the headers from the server will not be picked up.
            this.initSockets();
            this.app.use((error, req, res, next) => {
                logger.error(error);
                if (!res.headersSent) {
                    let httpCode = error.httpCode || 500;
                    res.status(httpCode).send(error);
                }
            });

            // start our server on port
            this.server.listen(cfg.port, cfg.ip, function () {
                logger.info('Server is now listening on %s:%s', cfg.ip, cfg.port);
            });
            this.isRunning = true;
        }
    }
    public addListenerOnce(event: any, f: (data: any) => void) {
        // for (let i = 0; i < this._sockets.length; i++) {
        //     this._sockets[i].once(event, f);
        // }
        this.sockServer.once(event, f);
    }
}
export class HttpsServer extends HttpServer {
    public server: https.Server;

    public init(cfg) {
        // const auth = require('http-auth');
        this.uuid = cfg.uuid;
        if (!cfg.enabled) return;
        try {
            this.app = express();
            // Enable Authentication (if configured)
            /*             if (cfg.authentication === 'basic') {
                            let basic = auth.basic({
                                realm: "nodejs-poolController.",
                                file: path.join(process.cwd(), cfg.authFile)
                            })
                            this.app.use(function(req, res, next) {
                                    (auth.connect(basic))(req, res, next);
                            });
                        } */
            if (cfg.sslKeyFile === '' || cfg.sslCertFile === '' || !fs.existsSync(path.join(process.cwd(), cfg.sslKeyFile)) || !fs.existsSync(path.join(process.cwd(), cfg.sslCertFile))) {
                logger.warn(`HTTPS not enabled because key or crt file is missing.`);
                return;
            }
            let opts = {
                key: fs.readFileSync(path.join(process.cwd(), cfg.sslKeyFile), 'utf8'),
                cert: fs.readFileSync(path.join(process.cwd(), cfg.sslCertFile), 'utf8'),
                requestCert: false,
                rejectUnauthorized: false
            }
            this.server = https.createServer(opts, this.app);

            this.app.use(express.json());
            this.app.use((req, res, next) => {
                res.header('Access-Control-Allow-Origin', '*');
                res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, api_key, Authorization'); // api_key and Authorization needed for Swagger editor live API document calls
                res.header('Access-Control-Allow-Methods', 'OPTIONS, GET, POST, PUT, DELETE');
                if ('OPTIONS' === req.method) { res.sendStatus(200); }
                else {
                    if (req.url !== '/device') {
                        logger.info(`[${new Date().toLocaleString()}] ${req.ip} ${req.method} ${req.url} ${typeof req.body === 'undefined' ? '' : JSON.stringify(req.body)}`);
                        logger.logAPI(`{"dir":"in","proto":"api","requestor":"${req.ip}","method":"${req.method}","path":"${req.url}",${typeof req.body === 'undefined' ? '' : `"body":${JSON.stringify(req.body)},`}"ts":"${Timestamp.toISOLocal(new Date())}"}${os.EOL}`);
                    }
                    next();
                }
            });


            // Put in a custom replacer so that we can send error messages to the client.  If we don't do this the base properties of Error
            // are omitted from the output.
            this.app.set('json replacer', (key, value) => {
                if (value instanceof Error) {
                    var err = {};
                    Object.getOwnPropertyNames(value).forEach((prop) => {
                        if (prop === "level") err[prop] = value[prop].replace(/\x1b\[\d{2}m/g, '') // remove color from level
                        else err[prop] = value[prop];
                    });
                    return err;
                }
                return value;
            });

            ConfigRoute.initRoutes(this.app);
            StateRoute.initRoutes(this.app);
            UtilitiesRoute.initRoutes(this.app);

            // The socket initialization needs to occur before we start listening.  If we don't then
            // the headers from the server will not be picked up.
            this.initSockets();
            this.app.use((error, req, res, next) => {
                logger.error(error);
                if (!res.headersSent) {
                    let httpCode = error.httpCode || 500;
                    res.status(httpCode).send(error);
                }
            });

            // start our server on port
            this.server.listen(cfg.port, cfg.ip, function () {
                logger.info('Server is now listening on %s:%s', cfg.ip, cfg.port);
            });
            this.isRunning = true;
        }
        catch (err) {
            logger.error(`Error starting up https server: ${err}`)
        }
    }
}
export class SsdpServer extends ProtoServer {
    // Simple service discovery protocol
    public server: any; //node-ssdp;
    public init(cfg) {
        this.uuid = cfg.uuid;
        if (cfg.enabled) {
            let self = this;

            logger.info('Starting up SSDP server');
            var udn = 'uuid:806f52f4-1f35-4e33-9299-' + webApp.mac();
            // todo: should probably check if http/https is enabled at this point
            var port = config.getSection('web').servers.http.port || 4200;
            //console.log(port);
            let location = 'http://' + webApp.ip() + ':' + port + '/device';
            var SSDP = ssdp.Server;
            this.server = new SSDP({
                logLevel: 'INFO',
                udn: udn,
                location: location,
                sourcePort: 1900
            });
            this.server.addUSN('urn:schemas-upnp-org:device:PoolController:1');

            // start the server
            this.server.start()
                .then(function () {
                    logger.silly('SSDP/UPnP Server started.');
                    self.isRunning = true;
                });

            this.server.on('error', function (e) {
                logger.error('error from SSDP:', e);
            });
        }
    }
    public static deviceXML() {
        let ver = sys.appVersion;
        let XML = `<?xml version="1.0"?>
                        <root xmlns="urn:schemas-upnp-org:PoolController-1-0">
                            <specVersion>
                                <major>${ver.split('.')[0]}</major>
                                <minor>${ver.split('.')[1]}</minor>
                                <patch>${ver.split('.')[2]}</patch>
                            </specVersion>
                            <device>
                                <deviceType>urn:echo:device:PoolController:1</deviceType>
                                <friendlyName>NodeJS Pool Controller</friendlyName> 
                                <manufacturer>tagyoureit</manufacturer>
                                <manufacturerURL>https://github.com/tagyoureit/nodejs-poolController</manufacturerURL>
                                <modelDescription>An application to control pool equipment.</modelDescription>
                                <serialNumber>0</serialNumber>
                    			<UDN>uuid:806f52f4-1f35-4e33-9299-${webApp.mac()}</UDN>
                                <serviceList></serviceList>
                            </device>
                        </root>`;
        return XML;
    }
    public async stopAsync() {
        try {
            this.server.stop();
            logger.info(`Stopped SSDP server: ${this.name}`);
        } catch (err) { logger.error(`Error stopping SSDP server ${err.message}`); }
    }
}
export class MdnsServer extends ProtoServer {
    // Multi-cast DNS server
    public server;
    public mdnsEmitter = new EventEmitter();
    private queries = [];
    public init(cfg) {
        this.uuid = cfg.uuid;
        if (cfg.enabled) {
            logger.info('Starting up MDNS server');
            this.server = multicastdns({ loopback: true });
            var self = this;

            // look for responses to queries we send
            // todo: need timeout on queries to remove them in case a bad query is sent
            this.server.on('response', function (responses) {
                self.queries.forEach(function (query) {
                    logger.silly(`looking to match on ${query.name}`);
                    responses.answers.forEach(answer => {
                        if (answer.name === query.name) {
                            logger.info(`MDNS: found response: ${answer.name} at ${answer.data}`);
                            // need to send response back to client here
                            self.mdnsEmitter.emit('mdnsResponse', answer);
                            // remove query from list
                            self.queries = self.queries.filter((value, index, arr) => {
                                if (value.name !== query.name) return arr;
                            });
                        }
                    });

                });
            });

            // respond to incoming MDNS queries
            this.server.on('query', function (query) {
                query.questions.forEach(question => {
                    if (question.name === '_poolcontroller._tcp.local') {
                        logger.info(`received mdns query for nodejs_poolController`);
                        self.server.respond({
                            answers: [{
                                name: '_poolcontroller._tcp.local',
                                type: 'A',
                                ttl: 300,
                                data: webApp.ip()
                            },
                            {
                                name: 'api._poolcontroller._tcp.local',
                                type: 'SRV',
                                data: {
                                    port: '4200',
                                    target: '_poolcontroller._tcp.local',
                                    weight: 0,
                                    priority: 10
                                }
                            }]
                        });
                    }
                });
            });

            this.isRunning = true;
        }
    }
    public queryMdns(query) {
        // sample query
        // queryMdns({name: '_poolcontroller._tcp.local', type: 'A'});
        if (this.queries.indexOf(query) === -1) {
            this.queries.push(query);
        }
        this.server.query({ questions: [query] });
    }
    public async stopAsync() {
        try {
            if (typeof this.server !== 'undefined')
                await new Promise<void>((resolve, reject) => {
                    this.server.destroy((err) => {
                        if (err) reject(err);
                        else resolve();
                    });
                });
            logger.info(`Shut down MDNS Server ${this.name}`);
        } catch (err) { logger.error(`Error shutting down MDNS Server ${this.name}: ${err.message}`); }
    }
}
export class HttpInterfaceServer extends ProtoServer {
    public bindingsPath: string;
    public bindings: HttpInterfaceBindings;
    private _fileTime: Date = new Date(0);
    private _isLoading: boolean = false;
    public init(cfg) {
        this.uuid = cfg.uuid;
        if (cfg.enabled) {
            if (cfg.fileName && this.initBindings(cfg)) this.isRunning = true;
        }
    }
    public loadBindings(cfg): boolean {
        this._isLoading = true;
        if (fs.existsSync(this.bindingsPath)) {
            try {
                let bindings = JSON.parse(fs.readFileSync(this.bindingsPath, 'utf8'));
                let ext = extend(true, {}, typeof cfg.context !== 'undefined' ? cfg.context.options : {}, bindings);
                this.bindings = Object.assign<HttpInterfaceBindings, any>(new HttpInterfaceBindings(cfg), ext);
                this.isRunning = true;
                this._isLoading = false;
                const stats = fs.statSync(this.bindingsPath);
                this._fileTime = stats.mtime;
                return true;
            }
            catch (err) {
                logger.error(`Error reading interface bindings file: ${this.bindingsPath}. ${err}`);
                this.isRunning = false;
                this._isLoading = false;
            }
        }
        return false;
    }
    public initBindings(cfg): boolean {
        let self = this;
        try {
            this.bindingsPath = path.posix.join(process.cwd(), "/web/bindings") + '/' + cfg.fileName;
            let fileTime = new Date(0).valueOf();
            fs.watch(this.bindingsPath, (event, fileName) => {
                if (fileName && event === 'change') {
                    if (self._isLoading) return; // Need a debounce here.  We will use a semaphore to cause it not to load more than once.
                    const stats = fs.statSync(self.bindingsPath);
                    if (stats.mtime.valueOf() === self._fileTime.valueOf()) return;
                    self.loadBindings(cfg);
                    logger.info(`Reloading ${cfg.name || ''} interface config: ${fileName}`);
                }
            });
            this.loadBindings(cfg);
            if (this.bindings.context.mdnsDiscovery) {
                let srv = webApp.mdnsServer;
                let qry = typeof this.bindings.context.mdnsDiscovery === 'string' ? { name: this.bindings.context.mdnsDiscovery, type: 'A' } : this.bindings.context.mdnsDiscovery;
                if (typeof srv !== 'undefined') {
                    srv.queryMdns(qry);
                    srv.mdnsEmitter.on('mdnsResponse', (response) => {
                        let url: URL;
                        url = new URL(response);
                        this.bindings.context.options.host = url.host;
                        this.bindings.context.options.port = url.port || 80;
                    });
                }
            }
            return true;
        }
        catch (err) {
            logger.error(`Error initializing interface bindings: ${err}`);
        }
        return false;
    }
    public emitToClients(evt: string, ...data: any) {
        if (this.isRunning) {
            // Take the bindings and map them to the appropriate http GET, PUT, DELETE, and POST.
            this.bindings.bindEvent(evt, ...data);
        }
    }
    public async stopAsync() {
        try {
            logger.info(`${this.name} Interface Server Shut down`);
        }
        catch (err) { }
    }
}

export class InfluxInterfaceServer extends ProtoServer {
    public bindingsPath: string;
    public bindings: InfluxInterfaceBindings;
    private _fileTime: Date = new Date(0);
    private _isLoading: boolean = false;
    public init(cfg) {
        this.uuid = cfg.uuid;
        if (cfg.enabled) {
            if (cfg.fileName && this.initBindings(cfg)) this.isRunning = true;
        }
    }
    public loadBindings(cfg): boolean {
        this._isLoading = true;
        if (fs.existsSync(this.bindingsPath)) {
            try {
                let bindings = JSON.parse(fs.readFileSync(this.bindingsPath, 'utf8'));
                let ext = extend(true, {}, typeof cfg.context !== 'undefined' ? cfg.context.options : {}, bindings);
                this.bindings = Object.assign<InfluxInterfaceBindings, any>(new InfluxInterfaceBindings(cfg), ext);
                this.isRunning = true;
                this._isLoading = false;
                const stats = fs.statSync(this.bindingsPath);
                this._fileTime = stats.mtime;
                return true;
            }
            catch (err) {
                logger.error(`Error reading interface bindings file: ${this.bindingsPath}. ${err}`);
                this.isRunning = false;
                this._isLoading = false;
            }
        }
        return false;
    }
    public initBindings(cfg): boolean {
        let self = this;
        try {
            this.bindingsPath = path.posix.join(process.cwd(), "/web/bindings") + '/' + cfg.fileName;
            fs.watch(this.bindingsPath, (event, fileName) => {
                if (fileName && event === 'change') {
                    if (self._isLoading) return; // Need a debounce here.  We will use a semaphore to cause it not to load more than once.
                    const stats = fs.statSync(self.bindingsPath);
                    if (stats.mtime.valueOf() === self._fileTime.valueOf()) return;
                    self.loadBindings(cfg);
                    logger.info(`Reloading ${cfg.name || ''} interface config: ${fileName}`);
                }
            });
            this.loadBindings(cfg);
            return true;
        }
        catch (err) {
            logger.error(`Error initializing interface bindings: ${err}`);
        }
        return false;
    }
    public emitToClients(evt: string, ...data: any) {
        if (this.isRunning) {
            // Take the bindings and map them to the appropriate http GET, PUT, DELETE, and POST.
            this.bindings.bindEvent(evt, ...data);
        }
    }
}

export class MqttInterfaceServer extends ProtoServer {
    public bindingsPath: string;
    public bindings: HttpInterfaceBindings;
    private _fileTime: Date = new Date(0);
    private _isLoading: boolean = false;
    public get isConnected() { return this.isRunning && this.bindings.events.length > 0; }
    public init(cfg) {
        this.uuid = cfg.uuid;
        if (cfg.enabled) {
            if (cfg.fileName && this.initBindings(cfg)) this.isRunning = true;
        }
    }
    public loadBindings(cfg): boolean {
        this._isLoading = true;
        if (fs.existsSync(this.bindingsPath)) {
            try {
                let bindings = JSON.parse(fs.readFileSync(this.bindingsPath, 'utf8'));
                let ext = extend(true, {}, typeof cfg.context !== 'undefined' ? cfg.context.options : {}, bindings);
                this.bindings = Object.assign<MqttInterfaceBindings, any>(new MqttInterfaceBindings(cfg), ext);
                this.isRunning = true;
                this._isLoading = false;
                const stats = fs.statSync(this.bindingsPath);
                this._fileTime = stats.mtime;
                return true;
            }
            catch (err) {
                logger.error(`Error reading interface bindings file: ${this.bindingsPath}. ${err}`);
                this.isRunning = false;
                this._isLoading = false;
            }
        }
        return false;
    }
    public initBindings(cfg): boolean {
        let self = this;
        try {
            this.bindingsPath = path.posix.join(process.cwd(), "/web/bindings") + '/' + cfg.fileName;
            let fileTime = new Date(0).valueOf();
            fs.watch(this.bindingsPath, (event, fileName) => {
                if (fileName && event === 'change') {
                    if (self._isLoading) return; // Need a debounce here.  We will use a semaphore to cause it not to load more than once.
                    const stats = fs.statSync(self.bindingsPath);
                    if (stats.mtime.valueOf() === self._fileTime.valueOf()) return;
                    self.loadBindings(cfg);
                    logger.info(`Reloading ${cfg.name || ''} interface config: ${fileName}`);
                }
            });
            this.loadBindings(cfg);
            return true;
        }
        catch (err) {
            logger.error(`Error initializing interface bindings: ${err}`);
        }
        return false;
    }
    public emitToClients(evt: string, ...data: any) {
        if (this.isRunning) {
            // Take the bindings and map them to the appropriate http GET, PUT, DELETE, and POST.
            this.bindings.bindEvent(evt, ...data);
        }
    }
    public async stopAsync() {
        try {
            if (typeof this.bindings !== 'undefined') await this.bindings.stopAsync();
        } catch (err) { logger.error(`Error shutting down MQTT Server ${this.name}: ${err.message}`); }
    }
}
export class InterfaceServerResponse {
    constructor(statusCode?: number, statusMessage?: string) {
        if (typeof statusCode !== 'undefined') this.status.code = statusCode;
        if (typeof statusMessage !== 'undefined') this.status.message = statusMessage;
    }
    status: { code: number, message: string } = { code: -1, message: '' };
    error: Error;
    data: string;
    obj: any;

}
export class REMInterfaceServer extends ProtoServer {
    public init(cfg) {
        this.cfg = cfg;
        this.uuid = cfg.uuid;
        if (cfg.enabled) {
            this.initSockets();
            setTimeout(async () => {
                try {
                    await this.initConnection();
                }
                catch (err) {
                    logger.error(`Error establishing bi-directional Nixie/REM connection: ${err}`)
                }
            }, 5000);
        }
    }
    private async initConnection() {
        try {
            // find HTTP server
            return new Promise<void>(async (resolve, reject) => {
                // First, send the connection info for njsPC and see if a connection exists.
                let url = '/config/checkconnection/';
                // can & should extend for https/username-password/ssl
                let data: any = { type: "njspc", isActive: true, id: null, name: "njsPC - automatic", protocol: "http:", ipAddress: webApp.ip(), port: config.getSection('web').servers.http.port || 4200, userName: "", password: "", sslKeyFile: "", sslCertFile: "" }
                let result = await this.putApiService(url, data, 5000);
                // If the result code is > 200 we have an issue. (-1 is for timeout)
                if (result.status.code > 200 || result.status.code < 0) return reject(new Error(`initConnection: ${result.error.message}`));
                else { this.remoteConnectionId = result.obj.id };

                // The passed connection has been setup/verified; now test for emit
                // if this fails, it could be because the remote connection is disabled.  We will not 
                // automatically re-enable it

                url = '/config/checkemit'
                data = { eventName: "checkemit", property: "result", value: 'success', connectionId: result.obj.id }
                // wait for REM server to finish resetting
                setTimeout(async () => {
                    try {
                        let _tmr = setTimeout(() => { return reject(new Error(`initConnection: No socket response received.  Check REM→njsPC communications.`)) }, 5000);
                        let srv: HttpServer = webApp.findServer('http') as HttpServer;
                        srv.addListenerOnce('/checkemit', (data: any) => {
                            // if we receive the emit, data will work both ways.
                            // console.log(data);
                            clearTimeout(_tmr);
                            logger.info(`REM bi-directional communications established.`)
                            return resolve();
                        });
                        result = await this.putApiService(url, data);
                        // If the result code is > 200 or -1 we have an issue.
                        if (result.status.code > 200 || result.status.code === -1) return reject(new Error(`initConnection: ${result.error.message}`));
                        else {
                            clearTimeout(_tmr);
                            return resolve();
                        }
                    }
                    catch (err) { reject(new Error(`initConnection setTimeout: ${result.error.message}`)); }
                }, 3000);
            });
        }
        catch (err) {
            logger.error(`Error with REM Interface Server initConnection: ${err}`)
        }
    }
    public async stopAsync() {
        try {
            if (typeof this.agent !== 'undefined') this.agent.destroy();
            if (typeof this.sockClient !== 'undefined') this.sockClient.destroy();
            logger.info(`Stopped REM Interface Server ${this.name}`);
        } catch (err) { logger.error(`Error closing REM Server ${this.name}: ${err.message}`); }
    }
    public cfg;
    public sockClient;
    protected agent: http.Agent = new http.Agent({ keepAlive: true });
    public get isConnected() { return this.sockClient !== 'undefined' && this.sockClient.connected; };
    private _sockets: RemoteSocket<ServerToClientEvents>[] = [];
    private async sendClientRequest(method: string, url: string, data?: any, timeout: number = 10000): Promise<InterfaceServerResponse> {
        try {

            let ret = new InterfaceServerResponse();
            let opts = extend(true, { headers: {} }, this.cfg.options);
            if ((typeof opts.hostname === 'undefined' || !opts.hostname) && (typeof opts.host === 'undefined' || !opts.host || opts.host === '*')) {
                ret.error = new Error(`Interface: ${this.cfg.name} has not resolved to a valid host.`)
                logger.warn(ret.error);
                return ret;
            }
            let sbody = typeof data === 'undefined' ? '' : typeof data === 'string' ? data : typeof data === 'object' ? JSON.stringify(data) : data.toString();
            if (typeof sbody !== 'undefined') {
                if (sbody.charAt(0) === '"' && sbody.charAt(sbody.length - 1) === '"') sbody = sbody.substr(1, sbody.length - 2);
                opts.headers["CONTENT-LENGTH"] = Buffer.byteLength(sbody || '');
            }
            opts.path = url;
            opts.method = method || 'GET';
            ret.data = '';
            opts.agent = this.agent;
            logger.verbose(`REM server request initiated. ${opts.method} ${opts.path} ${sbody}`);
            await new Promise<void>((resolve, reject) => {
                let req: http.ClientRequest;
                if (opts.port === 443 || (opts.protocol || '').startsWith('https')) {
                    opts.protocol = 'https:';
                    req = https.request(opts, (response: http.IncomingMessage) => {
                        ret.status.code = response.statusCode;
                        ret.status.message = response.statusMessage;
                        response.on('error', (err) => { ret.error = err; resolve(); });
                        response.on('data', (data) => { ret.data += data; });
                        response.on('end', () => { resolve(); });
                    });
                }
                else {
                    opts.protocol = undefined;
                    req = http.request(opts, (response: http.IncomingMessage) => {
                        ret.status.code = response.statusCode;
                        ret.status.message = response.statusMessage;
                        response.on('error', (err) => { ret.error = err; resolve(); });
                        response.on('data', (data) => { ret.data += data; });
                        response.on('end', () => { resolve(); });
                    });
                }
                req.setTimeout(timeout, () => { reject(new Error('Request timeout')); });
                req.on('error', (err, req, res) => {
                    logger.error(`Error sending Request: ${opts.method} ${url} ${err.message}`);
                    ret.error = err;
                    reject(new Error(`Error sending Request: ${opts.method} ${url} ${err.message}`));
                });
                req.on('abort', () => { logger.warn('Request Aborted'); reject(new Error('Request Aborted.')); });
                req.end(sbody);
            }).catch((err) => { logger.error(`Error Sending REM Request: ${opts.method} ${url} ${err.message}`); ret.error = err; });
            logger.verbose(`REM server request returned. ${opts.method} ${opts.path} ${sbody}`);
            if (ret.status.code > 200) {
                // We have an http error so let's parse it up.
                try {
                    ret.error = JSON.parse(ret.data);
                } catch (err) { ret.error = new Error(`Unidentified ${ret.status.code} Error: ${ret.status.message}`) }
                ret.data = '';
            }
            else if (ret.status.code === 200 && this.isJSONString(ret.data)) {
                try { ret.obj = JSON.parse(ret.data); }
                catch (err) { }
            }
            logger.debug(`REM server request returned. ${opts.method} ${opts.path} ${sbody} ${JSON.stringify(ret)}`);
            return ret;
        }
        catch (err) {
            logger.error(`Error sending HTTP ${method} command to ${url}: ${err.message}`);
            return Promise.reject(`Http ${method} Error ${url}:${err.message}`);
        }
    }
    private initSockets() {
        try {
            let self = this;
            let url = `${this.cfg.options.protocol || 'http://'}${this.cfg.options.host}${typeof this.cfg.options.port !== 'undefined' ? ':' + this.cfg.options.port : ''}`;
            logger.info(`Opening ${this.cfg.name} socket on ${url}`);
            //console.log(this.cfg);
            this.sockClient = sockClient(url, extend(true,
                { reconnectionDelay: 2000, reconnection: true, reconnectionDelayMax: 20000, transports: ['websocket'], upgrade: true, }, this.cfg.socket));
            if (typeof this.sockClient === 'undefined') return Promise.reject(new Error('Could not Initialize REM Server.  Invalid configuration.'));
            //this.sockClient = io.connect(url, { reconnectionDelay: 2000, reconnection: true, reconnectionDelayMax: 20000 });
            //console.log(this.sockClient);
            //console.log(typeof this.sockClient.on);
            this.sockClient.on('connect_error', (err) => { logger.error(`${this.cfg.name} socket connection error: ${err}`); });
            this.sockClient.on('connect_timeout', () => { logger.error(`${this.cfg.name} socket connection timeout`); });
            this.sockClient.on('reconnect', (attempts) => { logger.info(`${this.cfg.name} socket reconnected after ${attempts}`); });
            this.sockClient.on('reconnect_attempt', () => { logger.warn(`${this.cfg.name} socket attempting to reconnect`); });
            this.sockClient.on('reconnecting', (attempts) => { logger.warn(`${this.cfg.name} socket attempting to reconnect: ${attempts}`); });
            this.sockClient.on('reconnect_failed', (err) => { logger.warn(`${this.cfg.name} socket failed to reconnect: ${err}`); });
            this.sockClient.on('close', () => { logger.info(`${this.cfg.name} socket closed`); });
            this.sockClient.on('connect', () => {
                logger.info(`${this.cfg.name} socket connected`);
                this.sockClient.on('i2cDataValues', function (data) {
                    //logger.info(`REM Socket i2cDataValues ${JSON.stringify(data)}`);

                });
            });
            this.isRunning = true;
        }
        catch (err) { logger.error(err); }
    }
    private isJSONString(s: string): boolean {
        if (typeof s !== 'string') return false;
        if (typeof s.startsWith('{') || typeof s.startsWith('[')) return true;
        return false;
    }
    public async getApiService(url: string, data?: any, timeout: number = 3600): Promise<InterfaceServerResponse> {
        // Calls a rest service on the REM to set the state of a connected device.
        try { let ret = await this.sendClientRequest('GET', url, data, timeout); return ret; }
        catch (err) { return Promise.reject(err); }
    }
    public async putApiService(url: string, data?: any, timeout: number = 3600): Promise<InterfaceServerResponse> {
        // Calls a rest service on the REM to set the state of a connected device.
        try { let ret = await this.sendClientRequest('PUT', url, data, timeout); return ret; }
        catch (err) { return Promise.reject(err); }
    }
    public async searchApiService(url: string, data?: any, timeout: number = 3600): Promise<InterfaceServerResponse> {
        // Calls a rest service on the REM to set the state of a connected device.
        try { let ret = await this.sendClientRequest('SEARCH', url, data, timeout); return ret; }
        catch (err) { return Promise.reject(err); }
    }
    public async deleteApiService(url: string, data?: any, timeout: number = 3600): Promise<InterfaceServerResponse> {
        // Calls a rest service on the REM to set the state of a connected device.
        try { let ret = await this.sendClientRequest('DELETE', url, data, timeout); return ret; }
        catch (err) { return Promise.reject(err); }
    }
    public async getDevices() {
        try {
            let response = await this.sendClientRequest('GET', '/devices/all', undefined, 10000);
            return (response.status.code === 200) ? JSON.parse(response.data) : [];
        }
        catch (err) { logger.error(err); }
    }
}
export const webApp = new WebServer();
