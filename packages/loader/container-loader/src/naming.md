* `IContainer` (public):
  * `connectionState: ConnectionState`
    * `Disconnected`: no socket connection to delta server
    * `Pending`: socket connection established but we're not caught up
      * Unable to send outbound messages
      * Maybe inbound is still paused too, depends on `IContainerLoadMode.opsBeforeReturn`
    * `Connected`: connected and caught up
      * Not quite true for Read connection, see PR #9377
      * ClientId may not yet be in audience, see Issue #7275
      * Inbound/Outbound are operational (...is there a possible race condition if `IContainerLoadMode.opsBeforeReturn === undefined`?)
  * `connected: boolean`
    * `connectionState === ConnectionState.Connected`
  * `connect()`
    * Calls `DeltaManager.connect`  (and picks up some semantics from old `setAutoReconnect`?)
  * `disconnect()`
    * Disconnect from delta stream, until `connect()` is called again.
  * events emitted:
    * `connecting`: when starting to establish connection
    * `connectionPending`: when transitioned to Pending state
    * `connected`: when transitioned to Connected state
    * `disconnected`: when transitioned to Disconnected state
* `IDeltaManager` (public):
  * `active: boolean`
    * Indicates `Container.connectionState === Connected` and mode is write
  * events emitted
    * `deltaStreamConnected`: when socket is established. Triggers Container transition to `Pending` state
    * `deltaStreamDisconnected`: when socket is disconnected. Triggers Container transition to `Disconnected` state
* `DeltaManager` class (private)
  * `connectToDeltaStream`
    * Connect to delta stream
