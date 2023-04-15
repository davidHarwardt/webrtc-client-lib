

type RtcSocketClientMessage = {
    ty: "IceCandidate",
    target: string,
    candidate: RTCIceCandidateInit,
} | {
    ty: "Offer",
    target: string,
    offer: RTCSessionDescriptionInit,
} | {
    ty: "Answer",
    target: string,
    answer: RTCSessionDescriptionInit,
} | {
    ty: "Init",
    target: string,
    name: string,
};

type RtcSocketMessage = {
    ty: "JoinSelf",
    id: string,
} | {
    ty: "Join",
    id: string,
    username: string,
} | (Exclude<RtcSocketClientMessage, "target"> & { source: string });


const ICE_SERVERS = [
    {
        urls: [
            "stun:stun.l.google.com:19302",
            // "stun:stun1.l.google.com:19302",
            // "stun:stun2.l.google.com:19302",
            // "stun:stun3.l.google.com:19302",
            // "stun:stun4.l.google.com:19302",
        ],
    },
    // {
    //     urls: "turn:openrelay.metered.ca:80",
    //     username: "openrelayproject",
    //     credential: "openrelayproject",
    // },
];

type DataChannelDesc = Record<string, number>;

type Connection<C> = {
    conn: RTCPeerConnection,
    name: string,
    id: string,
    channels: Record<keyof C, RTCDataChannel>,
    connection_state: ConnectionState,
};

type ConnectionState = "init" | "open" | "closed";

type TypedArray = 
    | Int8Array
    | Uint8Array
    | Uint8ClampedArray
    | Int16Array
    | Uint16Array
    | Int32Array
    | Uint32Array
    | Float32Array
    | Float64Array;

type RtcMessageType = TypedArray | string | Blob | DataView;

class RtcManager<C extends DataChannelDesc> {
    private _connected: boolean;
    private _sock: WebSocket;

    private _room: string;
    private _name: string;

    private _chan_desc: C;
    private _own_id?: string;
    private _connections: Map<string, Connection<C>> = new Map();

    public onconnection: (conn: Connection<C>) => void = () => {};
    public onconnectionend: (conn: Connection<C>) => void = () => {};

    private _connection_events: ((conn: Connection<C>) => void)[] = [];
    private _connectionend_events: ((conn: Connection<C>) => void)[] = [];
    private _msg_events: ((msg: RtcMessageType, chan: keyof C, conn: Connection<C>) => void)[] = [];

    public get name() { return this._name }
    public get room() { return this._room }
    public get own_id() { return this._own_id }

    public constructor(sock: WebSocket, name: string, room: string, chan_desc: C) {
        if(sock.readyState === sock.CLOSING || sock.readyState === sock.CLOSED) {
            throw new Error("RtcManager received already closed WebSocket");
        }

        this._connected = sock.readyState === sock.OPEN;
        this._sock = sock;
        this._chan_desc = chan_desc;
        this._name = name;
        this._room = room;

        if(!this._connected) {
            sock.addEventListener("open", _ => {
                this._connected = true;
                this._init_connection();
            });
        } else {
            this._init_connection();
        }
    }

    public on_connection(cb: (conn: Connection<C>) => void) {
        this._connection_events.push(cb);
    }
    private _on_connection(conn: Connection<C>) {
        this.onconnection(conn);
        for(const cb of this._connection_events) { cb(conn) }
    }

    public on_connectionend(cb: (conn: Connection<C>) => void) {
        this._connectionend_events.push(cb);
    }
    private _on_connectionend(conn: Connection<C>) {
        this.onconnectionend(conn);
        for(const cb of this._connectionend_events) { cb(conn) }
    }

    private _init_connection() {
        console.log("initialising connections");
        if(!this._connected || this._sock.readyState !== this._sock.OPEN) {
            throw new Error("tried to call _init_connection without connected WebSocket");
        }

        this._sock.addEventListener("message", ev => {
            if(typeof ev.data === "string") {
                const msg = JSON.parse(ev.data) as RtcSocketMessage;

                switch(msg.ty) {
                    case "JoinSelf": {
                        this._own_id = msg.id;
                    } break;
                    case "Join": {
                        this._handle_join(msg.id, msg.username);
                    } break;
                    case "Init": {
                        this._init_conn(msg.source, msg.name);
                    } break;
                    case "IceCandidate": {
                        this._handle_ice(msg.source, msg.candidate);
                    } break;
                    case "Offer": {
                        this._handle_offer(msg.source, msg.offer);
                    } break;
                    case "Answer": {
                        this._handle_answer(msg.source, msg.answer);
                    } break;

                    default: console.warn("unknown socket message: ", msg); break;
                }
            } else { console.warn("got unexpected binary message") }
        });
    }

    private _get_conn(id: string) {
        let conn = this._connections.get(id);
        if(!conn) throw new Error(`could not get connection: invalid id: ${id}`);
        return conn.conn;
    }

    private _handle_join(id: string, name: string) {
        const conn = this._init_conn(id, name);
        this._sock.send(JSON.stringify({
            ty: "Init",
            target: id,
            name: this._name,
        } as RtcSocketClientMessage));

        conn.addEventListener("icecandidate", ev => {
            // console.log("candidate", ev.candidate);
            if(ev.candidate) {
                this._sock.send(JSON.stringify({
                    ty: "IceCandidate",
                    target: id,
                    candidate: ev.candidate?.toJSON(),
                } as RtcSocketClientMessage));
            }
        });
        this._create_offer(id);
    }

    private _init_conn(id: string, name: string) {
        console.log("_init_conn message", id, name);

        console.log("initializing conn (_init_conn)");
        const conn = new RTCPeerConnection({
            sdpSemantics: "unified-plan",
            iceServers: ICE_SERVERS,
        } as any);

        const channels = this._init_data_channels(conn, id);
        const connection_state = "init";
        const c = { conn, name, channels, connection_state, id } as Connection<C>;
        this._connections.set(id, c);
        const handler = () => {
            if(conn.connectionState === "connected") {
                c.connection_state = "open";
                this._on_connection(c);
            } else if(["disconnected", "closed", "failed"].includes(conn.connectionState)) {
                this._disconnect(id, c);
                conn.removeEventListener("connectionstatechange", handler);
            }
        };
        conn.addEventListener("connectionstatechange", handler);
        return conn;
    }

    private _disconnect(id: string, c: Connection<C>) {
        c.connection_state = "closed";
        this._connections.delete(id);
        this._on_connectionend(c);
    }

    private _handle_ice(id: string, candidateJson: RTCIceCandidateInit) {
        const candidate = new RTCIceCandidate(candidateJson);
        this._connections.get(id)?.conn.addIceCandidate(candidate);
    }

    private async _handle_offer(id: string, descr: RTCSessionDescriptionInit) {
        const conn = this._get_conn(id);

        await conn?.setRemoteDescription(descr);
        await this._create_answer(conn, id);
    }

    private async _handle_answer(id: string, descr: RTCSessionDescriptionInit) {
        const conn = this._get_conn(id);
        await conn.setRemoteDescription(descr);
    }

    private async _create_offer(id: string) {
        const conn = this._get_conn(id);
        let offer = await conn.createOffer();
        await conn.setLocalDescription(offer);
        this._sock.send(JSON.stringify({
            ty: "Offer",
            offer,
            target: id,
        } as RtcSocketClientMessage));
    }

    private async _create_answer(conn: RTCPeerConnection, id: string) {
        const answer = await conn.createAnswer();
        await conn.setLocalDescription(answer);

        this._sock.send(JSON.stringify({
            ty: "Answer",
            target: id,
            answer: answer,
        } as RtcSocketClientMessage));
    }

    private _init_data_channels(conn: RTCPeerConnection, user_id: string) {
        console.log("init connections");
        const data_channels: Record<keyof C, RTCDataChannel> = {} as any;
        for(const k in this._chan_desc) {
            let id = this._chan_desc[k];
            let chan = conn.createDataChannel(k, { negotiated: true, ordered: true, id });
            chan.addEventListener("message", ev => {
                this._on_message(ev.data, k, this._connections.get(user_id)!);
            });

            data_channels[k] = chan;
        }
        return data_channels;
    }

    public get_user(id: string): Promise<Connection<C>> {
        let conn = this._connections.get(id);
        if(!conn) throw new Error("tried to retrieve invalid connection");

        if(conn.conn.connectionState === "connected") { return Promise.resolve(conn) }
        return new Promise(res => {
            let handler = () => {
                if(conn!.conn.connectionState === "connected") {
                    conn!.conn.removeEventListener("connectionstatechange", handler);
                    res(conn!);
                }
            };
            conn!.conn.addEventListener("connectionstatechange", handler);
        });
    }

    public get_connections() {
        let res = [];
        for(const conn of this._connections.values()) {
            if(conn.connection_state === "open") res.push(conn);
        }
        return res;
    }

    public broadcast<T extends keyof C>(chan: T, data: RtcMessageType): void {
        const connections = this.get_connections();
        for(const conn of connections) {
            conn.channels[chan].send(data as any);
        }
    }

    public _on_message(msg: RtcMessageType, chan: keyof C, conn: Connection<C>) {
        for(const cb of this._msg_events) {
            cb(msg, chan, conn);
        }
    }

    public on_channel_message<T extends keyof C>(chan: T, cb: (msg: RtcMessageType, conn: Connection<C>) => void) {
        this.on_message((msg, rx_chan, conn) => { if(chan === rx_chan) cb(msg, conn) });
    }

    public on_message(cb: (msg: RtcMessageType, chan: keyof C, conn: Connection<C>) => void) {
        this._msg_events.push(cb);
    }
}

export type {
    Connection,
    DataChannelDesc,
    ConnectionState,
    RtcMessageType,
};

export {
    RtcManager,
};

