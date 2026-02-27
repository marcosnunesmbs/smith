interface ISmithProtocol {
    connect(): Promise<void>;
    disconnect(): Promise<void>;
    sendMessage(message: string): Promise<void>;
    receiveMessage(): Promise<string>;
    onMessageReceived(callback: (message: string) => void): void;
    getStatus(): Promise<string>;
}