interface ISmithTransport {
    connect(): Promise<void>;
    disconnect(): Promise<void>;
    sendMessage(message: string): Promise<void>;
    receiveMessage(): Promise<string>;
    onMessage(callback: (message: string) => void): void;
}