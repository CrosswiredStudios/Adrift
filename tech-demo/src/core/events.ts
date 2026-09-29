/**
 * Typed event bus. Systems publish what happened ("ship landed on Tethys",
 * "discovered the monolith") without knowing who listens; progression,
 * HUD toasts, audio and saves subscribe. Keeps game rules out of the
 * physics and rendering code.
 */
export type Listener<T> = (payload: T) => void;

export class EventBus<Events extends object> {
  private readonly listeners = new Map<keyof Events, Set<Listener<never>>>();

  on<K extends keyof Events>(type: K, fn: Listener<Events[K]>): () => void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(fn as Listener<never>);
    return () => set.delete(fn as Listener<never>);
  }

  once<K extends keyof Events>(type: K, fn: Listener<Events[K]>): () => void {
    const off = this.on(type, (p) => {
      off();
      fn(p);
    });
    return off;
  }

  emit<K extends keyof Events>(type: K, payload: Events[K]): void {
    const set = this.listeners.get(type);
    if (!set) return;
    for (const fn of [...set]) (fn as Listener<Events[K]>)(payload);
  }

  clear(): void {
    this.listeners.clear();
  }
}
