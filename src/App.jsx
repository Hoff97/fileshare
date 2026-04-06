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
  const marker = kind === 'answer' ? 'a' : 'o'
  const compactDescription = `${marker}${description.sdp.replace(/\r\n/g, '\n')}`

  return `${marker}:${compressToEncodedURIComponent(compactDescription)}`
}

function decodeSignal(rawText) {
  let token = rawText.trim()

  if (!token) {
    throw new Error('Paste a pairing code or invite link first.')
  }

  if (/^https?:\/\//i.test(token)) {
    const url = new URL(token)
    const offerToken = url.searchParams.get('o') ?? url.searchParams.get('offer')
    const answerToken = url.searchParams.get('a') ?? url.searchParams.get('answer')

    token = offerToken ? `o:${offerToken}` : answerToken ? `a:${answerToken}` : ''
  }

  const separatorIndex = token.indexOf(':')
  const prefix = separatorIndex >= 0 ? token.slice(0, separatorIndex) : ''
  const payload = separatorIndex >= 0 ? token.slice(separatorIndex + 1) : token
  const decoded = decompressFromEncodedURIComponent(payload)

  if (!decoded) {
    throw new Error('This pairing code could not be decoded.')
  }

  if (decoded.startsWith('{')) {
    const parsed = JSON.parse(decoded)
    const kind = parsed.kind ?? (prefix === 'o' ? 'offer' : 'answer')

    if (!parsed.description) {
      throw new Error('The pairing code is missing a WebRTC description.')
    }

    return { kind, description: parsed.description }
  }

  const marker = decoded[0] === 'a' ? 'a' : 'o'
  const kind = marker === 'a' ? 'answer' : 'offer'
  const sdp = decoded.slice(1).replace(/\n/g, '\r\n')

  if (!sdp) {
    throw new Error('The pairing code is missing WebRTC data.')
  }

  return {
    kind,
    description: {
      type: kind,
      sdp,
    },
  }
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
  const initialSignalFromUrl = (() => {
    if (typeof window === 'undefined') return ''

    const params = new URLSearchParams(window.location.search)
    return (
      params.get('o') ??
      params.get('offer') ??
      params.get('a') ??
      params.get('answer') ??
      ''
    )
  })()

  const [status, setStatus] = useState(
    initialSignalFromUrl
      ? 'Invite detected in the URL. Preparing the answer code…'
      : 'Ready to pair two devices.',
  )
  const [inviteLink, setInviteLink] = useState('')
  const [responseCode, setResponseCode] = useState('')
  const [manualCode, setManualCode] = useState(initialSignalFromUrl)
  const [isConnected, setIsConnected] = useState(false)
  const [outgoingFiles, setOutgoingFiles] = useState([])
  const [incomingFiles, setIncomingFiles] = useState([])
  const [scannerOpen, setScannerOpen] = useState(false)
  const [scannerError, setScannerError] = useState('')
  const [scannerTitle, setScannerTitle] = useState('Scan QR code')
  const [scannerPrompt, setScannerPrompt] = useState('Point the camera at the QR code on the other device.')

  const canScanQr = typeof window !== 'undefined' && 'BarcodeDetector' in window
  const appUrl = typeof window !== 'undefined'
    ? `${window.location.origin}${window.location.pathname}`
    : ''

  function addActivity() {}

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
      const nextInviteLink = `${appUrl}?o=${encodeURIComponent(token.slice(2))}`

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

  async function startScanner(mode = 'pair') {
    if (!canScanQr) {
      setScannerError('This browser does not support in-app QR scanning. Paste the answer code instead.')
      return
    }

    try {
      setScannerError('')
      setScannerTitle(mode === 'answer' ? 'Scan answer code' : 'Scan QR code')
      setScannerPrompt(
        mode === 'answer'
          ? 'Hold the answer QR inside the frame on the second device.'
          : 'Hold the QR code inside the frame on the other device.',
      )
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
    if (!initialSignalFromUrl) return

    void applySignalText(initialSignalFromUrl).catch((error) => {
      setStatus(error instanceof Error ? error.message : 'Could not accept the invite.')
    })

    window.history.replaceState({}, '', window.location.pathname)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialSignalFromUrl])

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
      <section className="panel top-panel">
        <div className="top-bar">
          <div className={`status-pill ${isConnected ? 'connected' : ''}`}>{status}</div>
          <div className="inline-actions">
            {!isConnected ? (
              <button type="button" className="button" onClick={createInvite}>
                Create QR
              </button>
            ) : null}
            <button type="button" className="button ghost" onClick={resetSession}>
              {isConnected ? 'Disconnect' : 'Reset'}
            </button>
          </div>
        </div>

        {!isConnected ? (
          <div className="connect-layout">
            <div className="qr-card connect-card">
              {inviteLink ? (
                <>
                  <h2>Invite QR</h2>
                  <QRCodeSVG value={inviteLink} size={176} level="L" />
                  <p className="card-copy">
                    Scan this on the other device to open the app with the pairing data.
                  </p>
                  <div className="inline-actions">
                    <button
                      type="button"
                      className="button secondary"
                      onClick={() => copyText(inviteLink, 'Invite link copied to the clipboard.')}
                    >
                      Copy invite link
                    </button>
                    {canScanQr ? (
                      <button
                        type="button"
                        className="button secondary"
                        onClick={() => startScanner('answer')}
                      >
                        Scan answer code
                      </button>
                    ) : null}
                    {navigator.share ? (
                      <button type="button" className="button secondary" onClick={shareInvite}>
                        Share invite
                      </button>
                    ) : null}
                  </div>
                </>
              ) : responseCode ? (
                <>
                  <h2>Answer QR</h2>
                  <QRCodeSVG value={responseCode} size={176} level="L" />
                  <p className="card-copy">
                    Show this back to the first device so it can finish the connection.
                  </p>
                  <button
                    type="button"
                    className="button secondary"
                    onClick={() => copyText(responseCode, 'Answer code copied to the clipboard.')}
                  >
                    Copy answer code
                  </button>
                </>
              ) : (
                <div className="empty-card">
                  <h2>Not connected</h2>
                  <p>Create an invite to show a QR code, or paste an invite link below.</p>
                </div>
              )}
            </div>

            <div className="manual-panel">
              <h3>Paste invite or answer</h3>
              <p>Use this as a fallback if scanning is not available.</p>
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
                  <button
                    type="button"
                    className="button secondary"
                    onClick={() => startScanner(inviteLink ? 'answer' : 'pair')}
                  >
                    Use camera
                  </button>
                ) : null}
              </div>
              {scannerError ? <p className="warning-text">{scannerError}</p> : null}
            </div>
          </div>
        ) : (
          <div className="files-view">
            <label className="dropzone">
              <input type="file" multiple onChange={handleFileSelection} />
              <span>Choose or drop files to send</span>
            </label>

            <div className="transfer-grid">
              <div>
                <h3>Sent</h3>
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
          </div>
        )}
      </section>

      {scannerOpen ? (
        <div className="scanner-overlay" role="dialog" aria-modal="true" aria-label={scannerTitle}>
          <div className="scanner-box scanner-modal">
            <h3>{scannerTitle}</h3>
            <p>{scannerPrompt}</p>
            <div className="scanner-preview">
              <video ref={videoRef} autoPlay muted playsInline />
              <div className="scanner-guide" aria-hidden="true" />
            </div>
            <p className="scanner-tip">Scanning starts automatically when a code is inside the frame.</p>
            <button type="button" className="button secondary" onClick={stopScanner}>
              Close scanner
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

export default App
