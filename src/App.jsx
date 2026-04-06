import { useCallback, useEffect, useRef, useState } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import {
  compressToEncodedURIComponent,
  decompressFromEncodedURIComponent,
} from 'lz-string'
import { consumeSharedFiles } from './shareTargetStore'
import './App.css'

const CHUNK_SIZE = 16 * 1024
const LOW_BUFFER_LIMIT = 256 * 1024
const SIGNAL_POLL_MS = 1200
const SIGNAL_WAIT_MS = 120000

function normalizeRoomId(value = '') {
  return value.trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 12).toUpperCase()
}

function extractRoomId(rawText = '') {
  const value = rawText.trim()

  if (!value) return ''

  if (/^https?:\/\//i.test(value)) {
    const url = new URL(value)
    return normalizeRoomId(url.searchParams.get('room') ?? url.searchParams.get('r') ?? '')
  }

  return normalizeRoomId(value)
}

function formatBytes(bytes = 0) {
  if (!bytes) return '0 B'

  const units = ['B', 'KB', 'MB', 'GB']
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / 1024 ** exponent

  return `${value.toFixed(value >= 10 || exponent === 0 ? 0 : 1)} ${units[exponent]}`
}

function getDeviceName() {
  if (typeof navigator === 'undefined') {
    return 'Another device'
  }

  const userAgent = navigator.userAgent ?? ''
  const platform = navigator.userAgentData?.platform ?? navigator.platform ?? ''

  let device = 'Unknown device'

  if (/iPhone/i.test(userAgent)) {
    device = 'iPhone'
  } else if (/iPad/i.test(userAgent)) {
    device = 'iPad'
  } else if (/Android/i.test(userAgent)) {
    device = /Mobile/i.test(userAgent) ? 'Android phone' : 'Android tablet'
  } else if (/Mac/i.test(platform)) {
    device = 'Mac'
  } else if (/Win/i.test(platform)) {
    device = 'Windows PC'
  } else if (/Linux/i.test(platform)) {
    device = 'Linux device'
  }

  let browser = 'Browser'

  if (/Edg\//i.test(userAgent)) {
    browser = 'Edge'
  } else if (/Firefox\//i.test(userAgent)) {
    browser = 'Firefox'
  } else if (/Chrome\//i.test(userAgent)) {
    browser = 'Chrome'
  } else if (/Safari\//i.test(userAgent)) {
    browser = 'Safari'
  }

  return `${device} · ${browser}`
}

function createLocalDeviceId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function getStoredDeviceId() {
  if (typeof localStorage === 'undefined') {
    return createLocalDeviceId()
  }

  try {
    const existingId = localStorage.getItem('peerdrop-device-id')

    if (existingId) {
      return existingId
    }

    const nextId = createLocalDeviceId()
    localStorage.setItem('peerdrop-device-id', nextId)
    return nextId
  } catch {
    return createLocalDeviceId()
  }
}

function formatNearbyStatus(device) {
  if (device.status === 'ready' && device.roomId) {
    return `Ready to pair · Room ${device.roomId}`
  }

  if (device.status === 'connected') {
    return 'Busy in an active transfer'
  }

  if (device.status === 'approval') {
    return 'Waiting for host approval'
  }

  return 'App open on this network'
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

function triggerDownload(url, filename) {
  if (typeof document === 'undefined') {
    return
  }

  const link = document.createElement('a')
  link.href = url
  link.download = filename || 'download'
  link.rel = 'noopener'
  link.style.display = 'none'
  document.body.append(link)
  link.click()
  link.remove()
}

function App() {
  const peerConnectionRef = useRef(null)
  const channelRef = useRef(null)
  const incomingRef = useRef({ currentId: null, files: new Map() })
  const sendQueueRef = useRef(Promise.resolve())
  const videoRef = useRef(null)
  const streamRef = useRef(null)
  const localDeviceIdRef = useRef(getStoredDeviceId())
  const frameRef = useRef(null)
  const objectUrlsRef = useRef([])
  const sessionTokenRef = useRef('')
  const autoInviteRequestedRef = useRef(false)
  const initialShareTargetLaunch = (() => {
    if (typeof window === 'undefined') return false
    return new URLSearchParams(window.location.search).has('share-target')
  })()
  const initialRoomFromUrl = (() => {
    if (typeof window === 'undefined') return ''

    const params = new URLSearchParams(window.location.search)
    return normalizeRoomId(params.get('room') ?? params.get('r') ?? '')
  })()
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
    initialShareTargetLaunch
      ? 'Shared files received. Preparing a room…'
      : initialRoomFromUrl
        ? 'Room link detected. Fetching the invite from the signaling service…'
        : initialSignalFromUrl
          ? 'Invite detected in the URL. Preparing the answer code…'
          : 'Ready to pair two devices.',
  )
  const [inviteLink, setInviteLink] = useState('')
  const [responseCode, setResponseCode] = useState('')
  const [roomCode, setRoomCode] = useState(initialRoomFromUrl)
  const [pendingSharedFiles, setPendingSharedFiles] = useState([])
  const [isConnected, setIsConnected] = useState(false)
  const [outgoingFiles, setOutgoingFiles] = useState([])
  const [incomingFiles, setIncomingFiles] = useState([])
  const [nearbyDevices, setNearbyDevices] = useState([])
  const [presenceError, setPresenceError] = useState('')
  const [scannerOpen, setScannerOpen] = useState(false)
  const [scannerError, setScannerError] = useState('')
  const [scannerTitle, setScannerTitle] = useState('Scan QR code')
  const [scannerPrompt, setScannerPrompt] = useState('Point the camera at the QR code on the other device.')
  const [pendingApproval, setPendingApproval] = useState(null)
  const [shareTargetState, setShareTargetState] = useState(() => ({
    tone: typeof navigator !== 'undefined' && 'serviceWorker' in navigator ? 'checking' : 'unsupported',
    label:
      typeof navigator !== 'undefined' && 'serviceWorker' in navigator
        ? 'Checking share target…'
        : 'Share target unsupported',
  }))

  const canScanQr = typeof window !== 'undefined' && 'BarcodeDetector' in window
  const localDeviceId = localDeviceIdRef.current
  const localDeviceName = getDeviceName()
  const appUrl = typeof window !== 'undefined'
    ? `${window.location.origin}${window.location.pathname}`
    : ''
  const signalingUrl = (import.meta.env.VITE_SIGNALING_URL ?? '').replace(/\/$/, '')
  const usesSignalServer = Boolean(signalingUrl)

  function addActivity() {}

  async function requestRoomState(roomId, init = {}) {
    if (!signalingUrl) {
      throw new Error('Set `VITE_SIGNALING_URL` to enable short room links.')
    }

    const response = await fetch(`${signalingUrl}/rooms/${roomId}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    })

    if (!response.ok) {
      throw new Error('Could not reach the signaling service. Check the worker URL and CORS settings.')
    }

    if (response.status === 204) {
      return null
    }

    return response.json()
  }

  const requestPresence = useCallback(async (init = {}) => {
    if (!signalingUrl) {
      return { devices: [] }
    }

    const query = new URLSearchParams({ deviceId: localDeviceId }).toString()
    const response = await fetch(`${signalingUrl}/presence?${query}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    })

    if (!response.ok) {
      throw new Error('Could not check for nearby devices through the signaling service.')
    }

    if (response.status === 204) {
      return { devices: [] }
    }

    return response.json()
  }, [localDeviceId, signalingUrl])

  async function waitForRoomDescription(roomId, field, sessionToken, waitMessage) {
    if (waitMessage) {
      setStatus(waitMessage)
    }

    const deadline = Date.now() + SIGNAL_WAIT_MS

    while (Date.now() < deadline) {
      if (sessionTokenRef.current !== sessionToken) {
        return null
      }

      const entry = (await requestRoomState(roomId))?.[field]

      if (entry?.description) {
        return entry
      }

      await new Promise((resolve) => window.setTimeout(resolve, SIGNAL_POLL_MS))
    }

    throw new Error(
      field === 'offer'
        ? `Room ${roomId} is still waiting for the host invite.`
        : `Room ${roomId} did not receive an answer in time.`,
    )
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
    sessionTokenRef.current = ''
    setPendingApproval(null)

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
    autoInviteRequestedRef.current = false
    setInviteLink('')
    setResponseCode('')
    setRoomCode('')
    setStatus(
      pendingSharedFiles.length
        ? 'Session reset. Shared files are still queued and a new room can be created.'
        : 'Session reset. Create a new invite to pair again.',
    )
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
        triggerDownload(url, entry.name)

        setIncomingFiles((current) =>
          updateTransferItems(current, payload.id, {
            progress: 100,
            status: 'Downloaded automatically',
            url,
          }),
        )

        addActivity(`Received ${entry.name} (${formatBytes(entry.size)}) and started the download.`)
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

    const sessionToken = crypto.randomUUID()
    sessionTokenRef.current = sessionToken

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

    return { peerConnection, sessionToken }
  }

  async function createInvite() {
    try {
      if (usesSignalServer) {
        const roomId = normalizeRoomId(crypto.randomUUID().slice(0, 8))
        const { peerConnection, sessionToken } = createPeerConnection()
        const dataChannel = peerConnection.createDataChannel('files', { ordered: true })

        attachDataChannel(dataChannel)
        setRoomCode(roomId)
        setInviteLink('')
        setResponseCode('')
        setStatus('Creating a short room link…')

        const offer = await peerConnection.createOffer()
        await peerConnection.setLocalDescription(offer)
        await waitForIceGatheringComplete(peerConnection)

        await requestRoomState(roomId, {
          method: 'POST',
          body: JSON.stringify({
            type: 'offer',
            description: peerConnection.localDescription,
          }),
        })

        const nextInviteLink = `${appUrl}?room=${encodeURIComponent(roomId)}`

        setInviteLink(nextInviteLink)
        setStatus(`Room ${roomId} is ready. Let the other device open the QR or short link.`)

        const answerEntry = await waitForRoomDescription(
          roomId,
          'answer',
          sessionToken,
          `Waiting for the second device to join room ${roomId}…`,
        )

        if (answerEntry?.description) {
          const requesterName = answerEntry.deviceName?.trim() || 'Another device'

          setPendingApproval({
            roomId,
            description: answerEntry.description,
            deviceName: requesterName,
          })
          setStatus(`${requesterName} wants to join room ${roomId}. Approve this connection to continue.`)
        }

        return
      }

      const { peerConnection } = createPeerConnection()
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
      setStatus('Invite ready. Scan it on the second device, then return the answer code.')
      addActivity('Invite QR code generated.')
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Could not generate an invite.')
    }
  }

  async function acceptInvite(description, roomId = '') {
    const { peerConnection } = createPeerConnection()

    if (roomId) {
      setRoomCode(roomId)
    }

    await peerConnection.setRemoteDescription(new RTCSessionDescription(description))

    const answer = await peerConnection.createAnswer()
    await peerConnection.setLocalDescription(answer)
    await waitForIceGatheringComplete(peerConnection)

    if (roomId && usesSignalServer) {
      await requestRoomState(roomId, {
        method: 'POST',
        body: JSON.stringify({
          type: 'answer',
          description: peerConnection.localDescription,
          deviceName: localDeviceName,
        }),
      })

      setInviteLink('')
      setResponseCode('')
      setStatus(`Connection request sent as ${localDeviceName}. Waiting for approval on the other device…`)
      return
    }

    const token = encodeSignal('answer', peerConnection.localDescription)

    setResponseCode(token)
    setInviteLink('')
    setStatus('Answer code ready. Show this QR code back to the first device.')
    addActivity('Answer QR code generated for the host device.')
  }

  async function joinRoom(roomId) {
    if (!usesSignalServer) {
      throw new Error('This room link needs a signaling server. Set `VITE_SIGNALING_URL` before using short room codes.')
    }

    const normalizedRoomId = normalizeRoomId(roomId)

    if (!normalizedRoomId) {
      throw new Error('Open a valid room link or scan the invite QR first.')
    }

    const waitingToken = crypto.randomUUID()
    sessionTokenRef.current = waitingToken
    setRoomCode(normalizedRoomId)
    setInviteLink('')
    setResponseCode('')
    setStatus(`Joining room ${normalizedRoomId}…`)

    const room = await requestRoomState(normalizedRoomId)
    const offerEntry =
      room?.offer ??
      (await waitForRoomDescription(
        normalizedRoomId,
        'offer',
        waitingToken,
        `Waiting for the host to publish the invite in room ${normalizedRoomId}…`,
      ))

    if (!offerEntry?.description) return

    await acceptInvite(offerEntry.description, normalizedRoomId)
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

  async function approvePendingConnection() {
    if (!pendingApproval?.description) {
      return
    }

    const { description, deviceName } = pendingApproval
    setPendingApproval(null)
    setStatus(`Approved ${deviceName}. Finalizing the direct connection…`)
    await applyAnswer(description)
  }

  async function declinePendingConnection() {
    const currentApproval = pendingApproval

    if (!currentApproval) {
      return
    }

    setPendingApproval(null)
    cleanupConnection()
    autoInviteRequestedRef.current = false
    setInviteLink('')
    setResponseCode('')
    setRoomCode('')

    if (usesSignalServer && currentApproval.roomId) {
      try {
        await requestRoomState(currentApproval.roomId, { method: 'DELETE' })
      } catch {
        // Ignore worker cleanup failures after a declined request.
      }
    }

    setStatus(`Declined connection from ${currentApproval.deviceName}. Create a new room to try again.`)
  }

  async function applySignalText(rawText) {
    const { kind, description } = decodeSignal(rawText)

    if (kind === 'offer') {
      await acceptInvite(description)
      return
    }

    if (kind === 'answer') {
      await applyAnswer(description)
      return
    }

    throw new Error('Unknown pairing code format.')
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
        text: usesSignalServer
          ? 'Open this short room link to pair directly for file sharing.'
          : 'Open this link to pair directly for file sharing.',
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

          try {
            const roomId = usesSignalServer ? extractRoomId(match.rawValue) : ''

            if (roomId) {
              await joinRoom(roomId)
            } else {
              await applySignalText(match.rawValue)
            }
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
    if (initialShareTargetLaunch) {
      void consumeSharedFiles()
        .then((files) => {
          if (!files.length) {
            setStatus('No shared files were attached. Create a room to start sharing.')
            return
          }

          setPendingSharedFiles(files)
          setStatus(
            usesSignalServer
              ? `Loaded ${files.length} shared file(s). Creating a room…`
              : `Loaded ${files.length} shared file(s). Creating an invite…`,
          )
        })
        .catch(() => {
          setStatus('Could not load the shared files from the share target.')
        })

      window.history.replaceState({}, '', window.location.pathname)
      return
    }

    if (initialRoomFromUrl) {
      void joinRoom(initialRoomFromUrl).catch((error) => {
        setStatus(error instanceof Error ? error.message : 'Could not join the room.')
      })

      window.history.replaceState({}, '', window.location.pathname)
      return
    }

    if (!initialSignalFromUrl) return

    void applySignalText(initialSignalFromUrl).catch((error) => {
      setStatus(error instanceof Error ? error.message : 'Could not accept the invite.')
    })

    window.history.replaceState({}, '', window.location.pathname)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialRoomFromUrl, initialShareTargetLaunch, initialSignalFromUrl, usesSignalServer])

  useEffect(() => {
    if (
      !pendingSharedFiles.length ||
      inviteLink ||
      isConnected ||
      peerConnectionRef.current ||
      autoInviteRequestedRef.current
    ) {
      return
    }

    autoInviteRequestedRef.current = true
    void createInvite()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingSharedFiles.length, inviteLink, isConnected])

  useEffect(() => {
    if (!isConnected || !pendingSharedFiles.length) {
      return
    }

    const filesToSend = pendingSharedFiles
    setPendingSharedFiles([])
    setStatus(`Peer connected. Sending ${filesToSend.length} shared file(s)…`)

    sendQueueRef.current = sendQueueRef.current
      .then(() => sendFiles(filesToSend))
      .catch(() => {
        setStatus('One of the shared files could not be sent.')
        setPendingSharedFiles(filesToSend)
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isConnected, pendingSharedFiles])

  useEffect(() => {
    if (!usesSignalServer) {
      setNearbyDevices([])
      setPresenceError('')
      return
    }

    let isActive = true

    const syncPresence = async () => {
      try {
        const result = await requestPresence({
          method: 'POST',
          body: JSON.stringify({
            deviceId: localDeviceId,
            deviceName: localDeviceName,
            roomId: roomCode,
            status: isConnected ? 'connected' : pendingApproval ? 'approval' : inviteLink ? 'ready' : 'idle',
          }),
        })

        if (!isActive) {
          return
        }

        setNearbyDevices(Array.isArray(result?.devices) ? result.devices : [])
        setPresenceError('')
      } catch {
        if (!isActive) {
          return
        }

        setPresenceError('Could not look for other devices on this network right now.')
      }
    }

    void syncPresence()
    const intervalId = window.setInterval(() => {
      void syncPresence()
    }, 15000)

    return () => {
      isActive = false
      window.clearInterval(intervalId)
    }
  }, [inviteLink, isConnected, localDeviceId, localDeviceName, pendingApproval, requestPresence, roomCode, usesSignalServer])

  useEffect(() => {
    if (!usesSignalServer) {
      return
    }

    const clearPresence = () => {
      void fetch(`${signalingUrl}/presence?deviceId=${encodeURIComponent(localDeviceId)}`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ deviceId: localDeviceId }),
        keepalive: true,
      }).catch(() => {
        // Ignore cleanup failures while unloading.
      })
    }

    window.addEventListener('pagehide', clearPresence)

    return () => {
      window.removeEventListener('pagehide', clearPresence)
    }
  }, [localDeviceId, signalingUrl, usesSignalServer])

  useEffect(() => {
    if (typeof window === 'undefined' || typeof navigator === 'undefined') {
      return
    }

    if (!('serviceWorker' in navigator)) {
      setShareTargetState({
        tone: 'unsupported',
        label: 'Share target unsupported',
      })
      return
    }

    let isActive = true
    let retryId = 0
    const displayModeQuery = window.matchMedia?.('(display-mode: standalone)')

    const syncShareTargetState = async () => {
      const isInstalled = Boolean(displayModeQuery?.matches) || window.navigator.standalone === true
      const registration = await navigator.serviceWorker.getRegistration()

      if (!isActive) {
        return
      }

      if (!registration) {
        setShareTargetState({
          tone: 'checking',
          label: 'Preparing share target…',
        })

        retryId = window.setTimeout(() => {
          void syncShareTargetState()
        }, 1200)

        return
      }

      setShareTargetState(
        isInstalled
          ? { tone: 'ready', label: 'Installed & ready' }
          : { tone: 'install', label: 'Install app to enable sharing' },
      )
    }

    const handleInstalled = () => {
      void syncShareTargetState()
    }

    void syncShareTargetState()
    window.addEventListener('appinstalled', handleInstalled)
    displayModeQuery?.addEventListener?.('change', handleInstalled)

    return () => {
      isActive = false

      if (retryId) {
        window.clearTimeout(retryId)
      }

      window.removeEventListener('appinstalled', handleInstalled)
      displayModeQuery?.removeEventListener?.('change', handleInstalled)
    }
  }, [])

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
          <div className="status-stack">
            <div className={`status-pill ${isConnected ? 'connected' : ''}`}>{status}</div>
            <div className={`share-target-pill ${shareTargetState.tone}`}>
              {shareTargetState.label}
            </div>
          </div>
          <div className="inline-actions">
            {!isConnected ? (
              <button type="button" className="button" onClick={createInvite}>
                {usesSignalServer ? 'Create room' : 'Create QR'}
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
                  {usesSignalServer && roomCode ? <p className="room-badge">Room {roomCode}</p> : null}
                  <QRCodeSVG value={inviteLink} size={176} level="L" />
                  <p className="card-copy">
                    {usesSignalServer
                      ? 'Scan this on the other device to open the app with the short room link.'
                      : 'Scan this on the other device to open the app with the pairing data.'}
                  </p>
                  {pendingSharedFiles.length ? (
                    <p className="queued-badge">
                      {pendingSharedFiles.length} shared file{pendingSharedFiles.length === 1 ? '' : 's'} queued — they will send automatically when the peer joins.
                    </p>
                  ) : null}
                  <div className="inline-actions">
                    <button
                      type="button"
                      className="button secondary"
                      onClick={() => copyText(inviteLink, 'Invite link copied to the clipboard.')}
                    >
                      Copy invite link
                    </button>
                    {!usesSignalServer && canScanQr ? (
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
              ) : responseCode && !usesSignalServer ? (
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
                  <p>
                    {pendingSharedFiles.length
                      ? 'Your shared files are queued. A room will be created automatically so someone else can join and receive them.'
                      : usesSignalServer
                        ? 'Create a room to show a short QR link for the other device.'
                        : 'Create an invite to show a QR code for the other device.'}
                  </p>
                </div>
              )}
            </div>

            {usesSignalServer ? (
              <div className="qr-card nearby-card">
                <h2>Devices on this network</h2>
                <p className="card-copy">Recently seen devices sharing the same network can appear here automatically.</p>
                <div className="nearby-list">
                  {nearbyDevices.length ? (
                    nearbyDevices.map((device) => (
                      <article className="nearby-item" key={device.deviceId}>
                        <div>
                          <strong>{device.deviceName || 'Another device'}</strong>
                          <p>{formatNearbyStatus(device)}</p>
                        </div>
                        {device.status === 'ready' && device.roomId ? (
                          <button
                            type="button"
                            className="button secondary"
                            onClick={() => {
                              void joinRoom(device.roomId).catch((error) => {
                                setStatus(error instanceof Error ? error.message : 'Could not join that device.')
                              })
                            }}
                          >
                            Join
                          </button>
                        ) : null}
                      </article>
                    ))
                  ) : (
                    <p className="empty-state">No other devices detected on this network right now.</p>
                  )}
                </div>
                {presenceError ? <p className="warning-text">{presenceError}</p> : null}
              </div>
            ) : null}

            {scannerError ? <p className="warning-text standalone-warning">{scannerError}</p> : null}
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

      {pendingApproval ? (
        <div className="scanner-overlay" role="dialog" aria-modal="true" aria-label="Approve connection">
          <div className="scanner-box verification-modal">
            <h3>Approve connection?</h3>
            <p>
              <strong className="verification-device">{pendingApproval.deviceName}</strong> wants to join
              {pendingApproval.roomId ? ` room ${pendingApproval.roomId}` : ' this session'}.
            </p>
            <p className="scanner-tip">
              Only approve this if you trust the device and expected the pairing request.
            </p>
            <div className="inline-actions">
              <button type="button" className="button" onClick={approvePendingConnection}>
                Approve
              </button>
              <button type="button" className="button ghost" onClick={declinePendingConnection}>
                Decline
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

export default App
