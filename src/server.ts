import http from "http";
import WebSocket from "ws";
import { DataHogMessage } from "./contracts";
import { logger } from "./logger";

export type DataHogHandler<TEvent extends NodeEvent> = (event: TEvent, socket: WebSocket) => void | Promise<void>;

export interface WhitelistedClientsEvent {
    domain: string;
    timestamp: number;
}

export interface NodeEvent {
    nodeId: string;
    timestamp: number;
}

export class DataHogServer {
    private server: http.Server;
    protected wss: WebSocket.Server;

    // tslint:disable-next-line:no-any
    protected eventHandlers: { [key: string]: DataHogHandler<any> } = {};

    constructor() {
        this.server = http.createServer();
        this.wss = new WebSocket.Server({ server: this.server });
        this.setupServer(this.wss);
    }

    public registerHandler<TEvent extends NodeEvent>(type: string, handler: DataHogHandler<TEvent>): void {
        this.eventHandlers[type] = handler;
    }

    public listen(port: number): void {
        this.server.listen(port, () => {
            logger.debug(`Server is listening on port ${port}`);
        });
    }

    private isPromise(maybePromise: unknown): maybePromise is Promise<unknown> {
        // tslint:disable-next-line:no-any
        return maybePromise != null && (maybePromise as any).then != null;
    }

    protected async handleEvent(message: DataHogMessage, socket: WebSocket): Promise<void> {
        const handler = this.eventHandlers[message.type];
        if (handler != null && typeof handler === "function") {
            try {
                const result = handler(message.payload, socket);
                if (this.isPromise(result)) {
                    await result;
                }
            } catch (err) {
                logger.error(err);
            }
        } else {
            // TODO: Handle error
            logger.error(`Got non-function server event handler: ${handler}`);
            throw new Error(`Got non-function server event handler: ${handler}`);
        }
    }

    protected setupServer(server: WebSocket.Server): void {
        server.on("connection", (socket: WebSocket) => {
            const address = server.address();
            if (typeof address === "string") {
                logger.debug(address);
            } else {
                logger.debug(`Connection received from: ${address.address}:${address.port} (${address.family}).`);
            }

            // Communication session heartbeat.
            let isAlive: boolean = true;
            socket.on("pong", () => {
                isAlive = true;
            });

            // tslint:disable-next-line:no-empty
            const noop = () => {};

            const interval = setInterval(() => {
                if (isAlive === false) {
                    if (socket == null) {
                        logger.error("Socket is null.");
                        throw new Error("Socket is null.");
                    }
                    clearInterval(interval);
                    return;
                }
                isAlive = false;
                socket.ping(noop);
            }, 10_000);

            socket.on("error", error => {
                logger.error(error);
            });

            socket.on("close", (code: any, reason: any) => {
                logger.warn(`Connection closed with a code '${code}' and a reason: ${reason}.`);
            });

            socket.on("message", (message: string) => {
                logger.debug(`Got message. ${message}`);
                try {
                    const dataHogMessage: DataHogMessage = JSON.parse(message);
                    this.handleEvent(dataHogMessage, socket);
                } catch (err) {
                    // TODO: Handle errors.
                    logger.error(err);
                    try {
                        socket.send(
                            JSON.stringify({
                                error: err.toString()
                            })
                        );
                    } catch {
                        // Nothing left to do.
                    }
                }
            });
        });
    }
}
