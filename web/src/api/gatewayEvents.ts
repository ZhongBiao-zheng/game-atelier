import type { GatewayTask } from './gateway';

type Listener = { onTask: (task: GatewayTask) => void; onConnect: () => void };
const listeners = new Set<Listener>();

export function subscribeGatewayEvents(listener: Listener) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function publishGatewayTask(task: GatewayTask) {
  listeners.forEach(listener => listener.onTask(task));
}
export function publishGatewayConnected() {
  listeners.forEach(listener => listener.onConnect());
}
