* `IContainer` (public):
  * `connectionState: ConnectionState`
    * `Disconnected`: no socket connection to delta server
    * `Connecting`: socket connection established but we're not caught up
      * Unable to send outbound messages
      * Maybe inbound is still paused too, depends on `IContainerLoadMode.opsBeforeReturn`
    * `Connected`: connected and caught up
      * Not quite true for Read connection, see PR #9377
      * ClientId may not yet be in audience, see Issue #7275
      * Inbound/Outbound are operational (...is there a possible race condition if `IContainerLoadMode.opsBeforeReturn === undefined`?)
  * `connected: boolean`
    * `connectionState === ConnectionState.Connected`
  * `resume()`
    * Calls `DeltaManager.connect`
  * `setAutoReconnect(reconnect: boolean)`
    * If false, will disconnect from delta stream.  If true, will probably connect to delta stream
  * events emitted:
    * `connected`: when transitioned to Connected state
    * `disconnected`: when transitioned to Disconnected state
* `IDeltaManager` (public):
  * `active: boolean`
    * Indicates `Container.connectionState === Connected` and mode is write
  * events emitted
    * `connect`: when socket is established. Triggers Container transition to `Connecting` state
    * `disconnect`: when socket is disconnected. Triggers Container transition to `Disconnected` state
* `DeltaManager` class (private)
  * `connect`
    * Connect to delta stream
