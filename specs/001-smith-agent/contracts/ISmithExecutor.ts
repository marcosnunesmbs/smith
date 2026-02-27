interface ISmithExecutor {
    executeCommand(command: string, args: string[]): Promise<any>;
    getStatus(): Promise<string>;
    stopExecution(): Promise<void>;
    onExecutionComplete(callback: (result: any) => void): void;
    onExecutionError(callback: (error: Error) => void): void;
}