import type { Stream } from '@agentclientprotocol/sdk'
import { createAcpProtocolRecorder } from './acp-protocol-recorder'
import type { ExternalAgentProtocolEvent } from './types'

type Message = Stream['readable'] extends ReadableStream<infer T> ? T : never

/** In-process ACP transport. Messages never pass through a byte codec. */
export function createAcpObjectStreamPair(
  onProtocolEvent?: (event: ExternalAgentProtocolEvent) => void | Promise<void>
): { clientStream: Stream; agentStream: Stream; dispose: () => void } {
  const record = createAcpProtocolRecorder(onProtocolEvent)
  const controllers: TransformStreamDefaultController<Message>[] = []
  let disposed = false

  const channel = (direction: ExternalAgentProtocolEvent['direction']) =>
    new TransformStream<Message, Message>({
      start(controller) {
        controllers.push(controller)
      },
      async transform(message, controller) {
        // Detach transported objects from the sender without a JSON round trip.
        const snapshot = structuredClone(message)
        if (onProtocolEvent) {
          // This is the equivalent JSON size for audit compatibility, not wire traffic.
          await record(direction, structuredClone(snapshot), Buffer.byteLength(JSON.stringify(snapshot)))
        }
        controller.enqueue(snapshot)
      }
    })

  const clientToAgent = channel('client_to_agent')
  const agentToClient = channel('agent_to_client')
  return {
    clientStream: { writable: clientToAgent.writable, readable: agentToClient.readable },
    agentStream: { writable: agentToClient.writable, readable: clientToAgent.readable },
    dispose() {
      if (disposed) return
      disposed = true
      // Works even while the SDK owns reader/writer locks; also rejects queued writes.
      const error = new Error('ACP object transport closed')
      for (const controller of controllers) controller.error(error)
    }
  }
}
