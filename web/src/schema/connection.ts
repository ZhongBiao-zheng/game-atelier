/** Minimal runtime discovery only. A null protocol must never enable hosted API access. */
export interface LocalConnectionStatus {
  service: 'game-atelier'
  instance_id: string
  app_version: string
  protocol: null
}

/** Only the boundary errors implemented so far, not the planned session protocol. */
export interface LocalConnectionBoundaryError {
  error: {
    code: 'HOST_DENIED' | 'ORIGIN_DENIED'
    message: string
    request_id: string
  }
}
