/** Local authenticated runtime protocol. */
export interface LocalConnectionStatus {
  service: 'game-atelier'
  instance_id: string
  app_version: string
  protocol: 'atelier-local/2'
}

/** Only the boundary errors implemented so far, not the planned session protocol. */
export interface LocalConnectionBoundaryError {
  error: {
    code: 'HOST_DENIED' | 'ORIGIN_DENIED'
    message: string
    request_id: string
  }
}
