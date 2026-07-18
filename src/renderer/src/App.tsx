import { lazy, Suspense, useEffect, useState } from 'react'

// Each Electron window loads only the renderer code required by its hash route.
const AgentWindow = lazy(() =>
  import('./components/AgentWindow').then(module => ({ default: module.AgentWindow }))
)
const PetWidget = lazy(() =>
  import('./components/PetWidget').then(module => ({ default: module.PetWidget }))
)
const ChatInputWindow = lazy(() =>
  import('./components/ChatInputWindow').then(module => ({ default: module.ChatInputWindow }))
)
const ScreenshotWindow = lazy(() =>
  import('./components/ScreenshotWindow').then(module => ({ default: module.ScreenshotWindow }))
)

function WindowLoadingFallback(): React.JSX.Element {
  return <div style={{ width: '100%', height: '100%', background: 'transparent' }} />
}

function App(): React.JSX.Element {
  const [currentHash, setCurrentHash] = useState(window.location.hash)

  useEffect(() => {
    const handleHashChange = (): void => {
      setCurrentHash(window.location.hash)
    }
    window.addEventListener('hashchange', handleHashChange)
    return () => window.removeEventListener('hashchange', handleHashChange)
  }, [])

  useEffect(() => {
    if (window.api && typeof window.api.onRequestGeolocation === 'function') {
      const cleanup = window.api.onRequestGeolocation(({ requestId }) => {
        navigator.geolocation.getCurrentPosition(
          (position) => {
            window.api.respondGeolocation(requestId, {
              latitude: position.coords.latitude,
              longitude: position.coords.longitude,
              accuracy: position.coords.accuracy
            })
          },
          (error) => {
            window.api.respondGeolocation(requestId, null, error.message)
          },
          { enableHighAccuracy: true, timeout: 10000 }
        )
      })
      return cleanup
    }
    return undefined
  }, [])

  const page = currentHash === '#/agent'
    ? <AgentWindow />
    : currentHash === '#/chat-input'
      ? <ChatInputWindow />
      : currentHash.startsWith('#/screenshot')
        ? <ScreenshotWindow />
        : <PetWidget />

  return <Suspense fallback={<WindowLoadingFallback />}>{page}</Suspense>
}

export default App
