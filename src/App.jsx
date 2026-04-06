import { useEffect, useRef, useState } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import {
  compressToEncodedURIComponent,
  decompressFromEncodedURIComponent,
} from 'lz-string'
import './App.css'

const CHUNK_SIZE = 16 * 1024
const LOW_BUFFER_LIMIT = 256 * 1024

function formatBytes(bytes = 0) {
  if (!bytes) return '0 B'

  const units = ['B', 'KB', 'MB', 'GB']
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / 1024 ** exponent

  return `${value.toFixed(value >= 10 || exponent === 0 ? 0 : 1)} ${units[exponent]}`
}

function encodeSignal(kind, description) {
  return `${kind[0]}:${compressToEncodedURIComponent(
    JSON.stringify({ kind, description }),
  )}`
}

function decodeSignal(rawText) {
  let token = rawText.trim()

  if (!token) {
    throw new Error('Paste a pairing code or invite link first.')
  }

  if (/^https?:\/\//i.test(token)) {
    const url = new URL(token)
    token = url.searchParams.get('offer') ?? url.searchParams.get('answer') ?? ''
  }

  const separatorIndex = token.indexOf(':')
  const prefix = separatorIndex >= 0 ? token.slice(0, separatorIndex) : ''
  const payload = separatorIndex >= 0 ? token.slice(separatorIndex + 1) : token
  const decoded = decompressFromEncodedURIComponent(payload)

  if (!decoded) {
    throw new Error('This pairing code could not be decoded.')
  }

  const parsed = JSON.parse(decoded)
  const kind = parsed.kind ?? (prefix === 'o' ? 'offer' : 'answer')

  if (!parsed.description) {
    throw new Error('The pairing code is missing a WebRTC description.')
  }

  return { kind, description: parsed.description }
}

function waitForIceGatheringComplete(peerConnection) {
  return new Promise((resolve) => {
    if (peerConnection.iceGatheringState === 'complete') {
      resolve()
      return
    }

    const handleChange = () => {
      if (peerConnection.iceGatheringState === 'complete') {
        peerConnection.removeEventListener('icegatheringstatechange', handleChange)
        resolve()
      }
    }

    peerConnection.addEventListener('icegatheringstatechange', handleChange)

    window.setTimeout(() => {
      peerConnection.removeEventListener('icegatheringstatechange', handleChange)
      resolve()
    }, 6000)
  })
}

function updateTransferItems(items, id, patch) {
  const index = items.findIndex((item) => item.id === id)

  if (index === -1) {
    return [{ id, ...patch }, ...items]
  }

  const nextItems = [...items]
  nextItems[index] = { ...nextItems[index], ...patch }
  return nextItems
}

function App() {
  const peerConnectionRef = useRef(null)
  const channelRef = useRef(null)
  const incomingRef = useRef({ currentId: null, files: new Map() })
  const sendQueueRef = useRef(Promise.resolve())
  const videoRef = useRef(null)
  const streamRef = useRef(null)
  const frameRef = useRef(null)
  const objectUrlsRef = useRef([])
  const initialOfferFromUrl = typeof window !== 'undefined'
    ? new URLSearchParams(window.location.search).get('offer') ?? ''
    : ''

  const [status, setStatus] = useState(
    initialOfferFromUrl
      ? 'Invite detected in the URL. Preparing the answer code…'
      : 'Ready to pair two devices.',
  )
  const [inviteLink, setInviteLink] = useState('')
  const [responseCode, setResponseCode] = useState('')
  const [manualCode, setManualCode] = useState(initialOfferFromUrl)
  const [isConnected, setIsConnected] = useState(false)
  const [outgoingFiles, setOutgoingFiles] = useState([])
  const [incomingFiles, setIncomingFiles] = useState([])
  const [activity, setActivity] = useState([
    'Tap “Create invite” on device A, then scan it from device B.',
  ])
  const [scannerOpen, setScannerOpen] = useState(false)
  const [scannerError, setScannerError] = useState('')

  const canScanQr = typeof window !== 'undefined' && 'BarcodeDetector' in window
  const appUrl = typeof window !== 'undefined'
    ? `${window.location.origin}${window.location.pathname}`
    : ''

  function addActivity(message) {
    setActivity((current) => [message, ...current].slice(0, 8))
  }

  function stopScanner() {
    if (frameRef.current) {
      cancelAnimationFrame(frameRef.current)
      frameRef.current = null
    }

    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop())
      streamRef.current = null
    }

    setScannerOpen(false)
  }

  function cleanupConnection() {
    stopScanner()

    if (channelRef.current) {
      channelRef.current.onopen = null
      channelRef.current.onclose = null
      channelRef.current.onmessage = null
      channelRef.current.close()
      channelRef.current = null
    }

    if (peerConnectionRef.current) {
      peerConnectionRef.current.ondatachannel = null
      peerConnectionRef.current.onconnectionstatechange = null
      peerConnectionRef.current.close()
      peerConnectionRef.current = null
    }

    incomingRef.current = { currentId: null, files: new Map() }
    setIsConnected(false)
  }

  function resetSession() {
    cleanupConnection()
    setInviteLink('')
    setResponseCode('')
    setManualCode('')
    setStatus('Session reset. Create a new invite to pair again.')
    addActivity('Session reset.')
  }

  function handleChannelMessage(event) {
    if (typeof event.data === 'string') {
      const payload = JSON.parse(event.data)

      if (payload.type === 'file-meta') {
        incomingRef.current.currentId = payload.id
        incomingRef.current.files.set(payload.id, {
          ...payload,
          chunks: [],
          received: 0,
        })

        setIncomingFiles((current) =>
          updateTransferItems(current, payload.id, {
            name: payload.name,
            size: payload.size,
            progress: 0,
            status: 'Receiving…',
          }),
        )

        return
      }

      if (payload.type === 'file-complete') {
        const entry = incomingRef.current.files.get(payload.id)

        if (!entry) return

        const blob = new Blob(entry.chunks, {
          type: entry.mime || 'application/octet-stream',
        })
        const url = URL.createObjectURL(blob)

        objectUrlsRef.current.push(url)
        incomingRef.current.files.delete(payload.id)
        incomingRef.current.currentId = null

        setIncomingFiles((current) =>
          updateTransferItems(current, payload.id, {
            progress: 100,
            status: 'Ready to download',
            url,
          }),
        )

        addActivity(`Received ${entry.name} (${formatBytes(entry.size)}).`)
      }

      return
    }

    const currentId = incomingRef.current.currentId

    if (!currentId) return

    const entry = incomingRef.current.files.get(currentId)

    if (!entry) return

    const chunk = event.data instanceof ArrayBuffer ? event.data : event.data.buffer

    entry.chunks.push(chunk)
    entry.received += chunk.byteLength

    setIncomingFiles((current) =>
      updateTransferItems(current, currentId, {
        progress: Math.min(
          100,
          Math.round((entry.received / Math.max(entry.size, 1)) * 100),
        ),
      }),
    )
  }

  function attachDataChannel(channel) {
    channelRef.current = channel
    channel.binaryType = 'arraybuffer'
    channel.bufferedAmountLowThreshold = LOW_BUFFER_LIMIT

    channel.onopen = () => {
      setIsConnected(true)
      setResponseCode('')
      setStatus('Connected. Both devices can now send files freely.')
      addActivity('Direct WebRTC connection established.')
    }

    channel.onclose = () => {
      setIsConnected(false)
      setStatus('Connection closed. Create a new invite to reconnect.')
      addActivity('Peer connection closed.')
    }

    channel.onmessage = handleChannelMessage
  }

  function createPeerConnection() {
    cleanupConnection()

    const peerConnection = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    })

    peerConnectionRef.current = peerConnection

    peerConnection.ondatachannel = (event) => {
      attachDataChannel(event.channel)
    }

    peerConnection.onconnectionstatechange = () => {
      if (peerConnection.connectionState === 'connecting') {
        setStatus('Pairing handshake accepted. Establishing direct connection…')
      }

      if (peerConnection.connectionState === 'failed') {
        setIsConnected(false)
        setStatus('Direct connection failed. Try again on the same network or generate a fresh invite.')
        addActivity('Connection attempt failed on this network.')
      }
    }

    return peerConnection
  }

  async function createInvite() {
    try {
      const peerConnection = createPeerConnection()
      const dataChannel = peerConnection.createDataChannel('files', { ordered: true })

      attachDataChannel(dataChannel)
      setStatus('Generating invite QR code…')

      const offer = await peerConnection.createOffer()
      await peerConnection.setLocalDescription(offer)
      await waitForIceGatheringComplete(peerConnection)

      const token = encodeSignal('offer', peerConnection.localDescription)
      const nextInviteLink = `${appUrl}?offer=${encodeURIComponent(token)}`

      setInviteLink(nextInviteLink)
      setResponseCode('')
      setManualCode('')
      setStatus('Invite ready. Scan it on the second device, then return the answer code.')
      addActivity('Invite QR code generated.')
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Could not generate an invite.')
    }
  }

  async function acceptInvite(description) {
    const peerConnection = createPeerConnection()

    await peerConnection.setRemoteDescription(new RTCSessionDescription(description))

    const answer = await peerConnection.createAnswer()
    await peerConnection.setLocalDescription(answer)
    await waitForIceGatheringComplete(peerConnection)

    const token = encodeSignal('answer', peerConnection.localDescription)

    setResponseCode(token)
    setInviteLink('')
    setStatus('Answer code ready. Show this QR code back to the first device.')
    addActivity('Answer QR code generated for the host device.')
  }

  async function applyAnswer(description) {
    const peerConnection = peerConnectionRef.current

    if (!peerConnection) {
      throw new Error('Create an invite on the first device before applying the answer code.')
    }

    await peerConnection.setRemoteDescription(new RTCSessionDescription(description))
    setStatus('Answer accepted. Finalizing the direct connection…')
    addActivity('Answer code accepted by the first device.')
  }

  async function applySignalText(rawText = manualCode) {
    const { kind, description } = decodeSignal(rawText)

    if (kind === 'offer') {
      await acceptInvite(description)
      setManualCode('')
      return
    }

    if (kind === 'answer') {
      await applyAnswer(description)
      setManualCode('')
      return
    }

    throw new Error('Unknown pairing code format.')
  }

  async function handleManualConnect() {
    try {
      await applySignalText()
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'The pairing code was invalid.')
    }
  }

  async function copyText(text, successMessage) {
    try {
      await navigator.clipboard.writeText(text)
      setStatus(successMessage)
    } catch {
      setStatus('Copy failed in this browser. You can still select and copy the text manually.')
    }
  }

  async function shareInvite() {
    if (!navigator.share || !inviteLink) return

    try {
      await navigator.share({
        title: 'PeerDrop Fileshare invite',
        text: 'Open this link to pair directly for file sharing.',
        url: inviteLink,
      })
    } catch {
      // Ignore aborted shares.
    }
  }

  async function waitForDrain(channel) {
    if (channel.bufferedAmount <= LOW_BUFFER_LIMIT) {
      return
    }

    await new Promise((resolve) => {
      const handleLowBuffer = () => {
        channel.removeEventListener('bufferedamountlow', handleLowBuffer)
        resolve()
      }

      channel.addEventListener('bufferedamountlow', handleLowBuffer)
    })
  }

  async function sendFiles(files) {
    const channel = channelRef.current

    if (!channel || channel.readyState !== 'open') {
      setStatus('Pair the devices first. The file channel is not open yet.')
      return
    }

    for (const file of files) {
      const id = crypto.randomUUID()

      setOutgoingFiles((current) =>
        updateTransferItems(current, id, {
          name: file.name,
          size: file.size,
          progress: 0,
          status: 'Sending…',
        }),
      )

      channel.send(
        JSON.stringify({
          type: 'file-meta',
          id,
          name: file.name,
          size: file.size,
          mime: file.type,
        }),
      )

      let offset = 0

      while (offset < file.size) {
        await waitForDrain(channel)

        const buffer = await file.slice(offset, offset + CHUNK_SIZE).arrayBuffer()
        channel.send(buffer)
        offset += buffer.byteLength

        setOutgoingFiles((current) =>
          updateTransferItems(current, id, {
            progress: Math.min(100, Math.round((offset / Math.max(file.size, 1)) * 100)),
          }),
        )
      }

      channel.send(JSON.stringify({ type: 'file-complete', id }))

      setOutgoingFiles((current) =>
        updateTransferItems(current, id, {
          progress: 100,
          status: 'Sent',
        }),
      )

      addActivity(`Sent ${file.name} (${formatBytes(file.size)}).`)
    }
  }

  function handleFileSelection(event) {
    const files = Array.from(event.target.files ?? [])

    if (!files.length) return

    sendQueueRef.current = sendQueueRef.current
      .then(() => sendFiles(files))
      .catch(() => {
        setStatus('One of the files could not be sent.')
      })

    event.target.value = ''
  }

  async function startScanner() {
    if (!canScanQr) {
      setScannerError('This browser does not support in-app QR scanning. Paste the answer code instead.')
      return
    }

    try {
      setScannerError('')
      setScannerOpen(true)

      const detector = new window.BarcodeDetector({ formats: ['qr_code'] })
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
      })

      streamRef.current = stream

      if (videoRef.current) {
        videoRef.current.srcObject = stream
        await videoRef.current.play()
      }

      const scanFrame = async () => {
        if (!videoRef.current) return

        const codes = await detector.detect(videoRef.current)
        const match = codes.find((item) => item.rawValue)

        if (match?.rawValue) {
          stopScanner()
          setManualCode(match.rawValue)

          try {
            await applySignalText(match.rawValue)
          } catch (error) {
            setStatus(error instanceof Error ? error.message : 'The scanned code was invalid.')
          }

          return
        }

        frameRef.current = requestAnimationFrame(() => {
          void scanFrame()
        })
      }

      void scanFrame()
    } catch {
      stopScanner()
      setScannerError('Camera access is unavailable. Paste the answer code instead.')
    }
  }

  useEffect(() => {
    if (!initialOfferFromUrl) return

    void applySignalText(initialOfferFromUrl).catch((error) => {
      setStatus(error instanceof Error ? error.message : 'Could not accept the invite.')
    })

    window.history.replaceState({}, '', window.location.pathname)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialOfferFromUrl])

  useEffect(() => {
    const objectUrls = objectUrlsRef.current

    return () => {
      cleanupConnection()
      objectUrls.forEach((url) => URL.revokeObjectURL(url))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="app-shell">
      <header className="hero-card">
        <div>
          <p className="eyebrow">PWA · WebRTC · QR pairing</p>
          <h1>PeerDrop Fileshare</h1>
          <p className="lead">
            Share files directly between two browsers with no app server. Pair once,
            then both devices can keep sending files in the same session.
          </p>
        </div>
        <div className="hero-badges">
          <span>Installable PWA</span>
          <span>Direct data channel</span>
          <span>Manual fallback</span>
        </div>
      </header>

      <main className="main-grid">
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>1. Pair the devices</h2>
              <p>Device A creates the invite. Device B scans it and returns the answer QR.</p>
            </div>
            <button type="button" className="button" onClick={createInvite}>
              Create invite
            </button>
          </div>

          <div className={`status-pill ${isConnected ? 'connected' : ''}`}>{status}</div>

          {inviteLink ? (
            <div className="qr-card">
              <h3>Invite QR for device B</h3>
              <QRCodeSVG value={inviteLink} size={188} includeMargin level="M" />
              <p className="card-copy">
                Scan this with the second device’s camera to open the app with the WebRTC offer.
              </p>
              <div className="inline-actions">
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => copyText(inviteLink, 'Invite link copied to the clipboard.')}
                >
                  Copy invite link
                </button>
                {navigator.share ? (
                  <button type="button" className="button secondary" onClick={shareInvite}>
                    Share invite
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}

          {responseCode ? (
            <div className="qr-card accent-card">
              <h3>Answer QR for device A</h3>
              <QRCodeSVG value={responseCode} size={188} includeMargin level="M" />
              <p className="card-copy">
                Show this to the first device. It can scan the QR in-app or paste the code below.
              </p>
              <button
                type="button"
                className="button secondary"
                onClick={() => copyText(responseCode, 'Answer code copied to the clipboard.')}
              >
                Copy answer code
              </button>
            </div>
          ) : null}

          <div className="manual-panel">
            <h3>Manual fallback</h3>
            <p>
              Paste either the invite link from device A or the answer code from device B.
            </p>
            <textarea
              value={manualCode}
              onChange={(event) => setManualCode(event.target.value)}
              placeholder="Paste an invite link or answer code here"
              rows={4}
            />
            <div className="inline-actions">
              <button type="button" className="button" onClick={handleManualConnect}>
                Apply code
              </button>
              {canScanQr ? (
                <button type="button" className="button secondary" onClick={startScanner}>
                  Scan answer QR
                </button>
              ) : null}
              <button type="button" className="button ghost" onClick={resetSession}>
                Reset session
              </button>
            </div>
            {scannerError ? <p className="warning-text">{scannerError}</p> : null}
            {scannerOpen ? (
              <div className="scanner-box">
                <video ref={videoRef} autoPlay muted playsInline />
                <button type="button" className="button secondary" onClick={stopScanner}>
                  Stop camera
                </button>
              </div>
            ) : null}
          </div>
        </section>

        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>2. Send files both ways</h2>
              <p>Once connected, the same direct session can be reused for unlimited sends.</p>
            </div>
          </div>

          <label className={`dropzone ${isConnected ? '' : 'disabled'}`}>
            <input type="file" multiple disabled={!isConnected} onChange={handleFileSelection} />
            <span>{isConnected ? 'Choose or drop files to send' : 'Pair devices first'}</span>
          </label>

          <div className="transfer-grid">
            <div>
              <h3>Outgoing</h3>
              <div className="transfer-list">
                {outgoingFiles.length ? (
                  outgoingFiles.map((file) => (
                    <article className="transfer-item" key={file.id}>
                      <div>
                        <strong>{file.name}</strong>
                        <p>
                          {formatBytes(file.size)} · {file.status}
                        </p>
                      </div>
                      <progress max="100" value={file.progress ?? 0} />
                    </article>
                  ))
                ) : (
                  <p className="empty-state">Nothing sent yet.</p>
                )}
              </div>
            </div>

            <div>
              <h3>Received</h3>
              <div className="transfer-list">
                {incomingFiles.length ? (
                  incomingFiles.map((file) => (
                    <article className="transfer-item" key={file.id}>
                      <div>
                        <strong>{file.name}</strong>
                        <p>
                          {formatBytes(file.size)} · {file.status}
                        </p>
                      </div>
                      <progress max="100" value={file.progress ?? 0} />
                      {file.url ? (
                        <a className="download-link" href={file.url} download={file.name}>
                          Download
                        </a>
                      ) : null}
                    </article>
                  ))
                ) : (
                  <p className="empty-state">Nothing received yet.</p>
                )}
              </div>
            </div>
          </div>
        </section>
      </main>

      <section className="panel footer-panel">
        <div>
          <h2>How the serverless flow works</h2>
          <ol className="steps">
            <li>Device A generates a QR code containing the app URL and compressed WebRTC offer.</li>
            <li>Device B scans the URL, opens the PWA, and generates the answer locally.</li>
            <li>Device B shows an answer QR code back to device A to complete the handshake.</li>
            <li>The actual file bytes move over a direct WebRTC data channel.</li>
          </ol>
        </div>

        <div>
          <h3>Activity</h3>
          <ul className="activity-list">
            {activity.map((entry) => (
              <li key={entry}>{entry}</li>
            ))}
          </ul>
          <p className="footnote">
            No TURN relay is configured, so restrictive networks can still block a direct connection.
            For best results, use Chromium-based browsers on the same LAN or with open NAT traversal.
          </p>
        </div>
      </section>
    </div>
  )
}

export default App
