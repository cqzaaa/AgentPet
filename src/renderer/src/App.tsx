import { useEffect, useState } from 'react'
import * as PIXI from 'pixi.js'
import { AgentWindow } from './components/AgentWindow'
import { PetWidget } from './components/PetWidget'

// pixi-live2d-display@0.4 + pixi.js@6 需要全局暴露 PIXI 以驱动 Ticker
// 必须在模块作用域最外层执行（不是在函数/useEffect 里）
;(window as unknown as { PIXI: typeof PIXI }).PIXI = PIXI

function App(): React.JSX.Element {
  const [isAgent, setIsAgent] = useState(window.location.hash === '#/agent')

  useEffect(() => {
    const handleHashChange = (): void => {
      setIsAgent(window.location.hash === '#/agent')
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

  return isAgent ? <AgentWindow /> : <PetWidget />
}

export default App
