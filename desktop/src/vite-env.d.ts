/// <reference types="vite/client" />

interface Window {
  MonacoEnvironment: {
    getWorker(workerId: string, label: string): Worker;
  };
}
