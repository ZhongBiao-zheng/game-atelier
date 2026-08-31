/** Minimal runtime discovery only. A null protocol must never enable hosted API access. */
export interface LocalConnectionStatus {
  service: 'game-atelier'
  instance_id: string
  app_version: string
  protocol: null
}
