const PRESENCE_TTL_MS = 45 * 1000

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders,
    },
  })
}

function getNetworkIdentity(request) {
  const cf = request.cf ?? {}
  const rawIp =
    request.headers.get('CF-Connecting-IP') ??
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    ''

  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(rawIp)) {
    return {
      rawIp,
      family: 'ipv4',
      bucket: `ipv4:${rawIp}`,
      asn: cf.asn ?? 'unknown',
      colo: cf.colo ?? 'unknown',
    }
  }

  if (rawIp.includes(':')) {
    const normalized = rawIp.split('%')[0]
    const parts = normalized.split(':').filter(Boolean)

    return {
      rawIp,
      family: 'ipv6',
      bucket: `ipv6:${parts.slice(0, 4).join(':') || 'unknown'}::/64`,
      asn: cf.asn ?? 'unknown',
      colo: cf.colo ?? 'unknown',
    }
  }

  return {
    rawIp: rawIp || 'unknown',
    family: 'unknown',
    bucket: `fallback:${cf.asn ?? 'unknown'}:${cf.colo ?? 'unknown'}`,
    asn: cf.asn ?? 'unknown',
    colo: cf.colo ?? 'unknown',
  }
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders })
    }

    const url = new URL(request.url)

    if (url.pathname === '/presence') {
      const network = getNetworkIdentity(request)
      const requestHeaders = new Headers(request.headers)
      requestHeaders.set('x-network-bucket', network.bucket)
      requestHeaders.set('x-network-family', network.family)

      console.log(
        `[presence] ${request.method} bucket=${network.bucket} ip=${network.rawIp} asn=${network.asn} colo=${network.colo}`,
      )

      const durableObjectId = env.PRESENCE.idFromName(network.bucket)
      const presence = env.PRESENCE.get(durableObjectId)

      return presence.fetch(new Request(request, { headers: requestHeaders }))
    }

    const match = url.pathname.match(/^\/rooms\/([A-Za-z0-9_-]{4,20})$/)

    if (!match) {
      return json({ error: 'Not found' }, 404)
    }

    const roomId = match[1].toUpperCase()

    console.log(`[room] ${request.method} room=${roomId}`)

    const durableObjectId = env.ROOMS.idFromName(roomId)
    const room = env.ROOMS.get(durableObjectId)

    return room.fetch(new Request(request, { headers: request.headers }))
  },
}

export class NetworkPresenceCoordinator {
  constructor(state) {
    this.state = state
  }

  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders })
    }

    const url = new URL(request.url)
    const networkBucket = request.headers.get('x-network-bucket') ?? 'unknown-network'
    const now = Date.now()
    const requestedDeviceId = (url.searchParams.get('deviceId') ?? '').trim()
    const devices = (await this.state.storage.get('devices')) ?? {}

    console.log(
      `[presence-do] ${request.method} bucket=${networkBucket} known=${Object.keys(devices).length} deviceId=${requestedDeviceId || 'n/a'}`,
    )

    for (const [deviceId, entry] of Object.entries(devices)) {
      if (now - (entry?.updatedAt ?? 0) > PRESENCE_TTL_MS) {
        delete devices[deviceId]
      }
    }

    if (request.method === 'GET') {
      await this.state.storage.put('devices', devices)
      return json({
        networkBucket,
        devices: Object.values(devices)
          .filter((entry) => entry?.deviceId && entry.deviceId !== requestedDeviceId)
          .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0)),
      })
    }

    if (request.method === 'POST') {
      const body = await request.json().catch(() => null)

      if (!body?.deviceId) {
        return json({ error: 'Expected { deviceId, deviceName } payload.' }, 400)
      }

      const trimmedDeviceId = String(body.deviceId).slice(0, 120)
      const nextEntry = {
        deviceId: trimmedDeviceId,
        deviceName:
          typeof body.deviceName === 'string' && body.deviceName.trim()
            ? body.deviceName.trim().slice(0, 80)
            : 'Another device',
        roomId: typeof body.roomId === 'string' ? body.roomId.trim().slice(0, 12).toUpperCase() : '',
        status:
          typeof body.status === 'string' && ['idle', 'ready', 'connected', 'approval'].includes(body.status)
            ? body.status
            : 'idle',
        updatedAt: now,
      }

      devices[trimmedDeviceId] = nextEntry

      console.log(
        `[presence-do] upsert bucket=${networkBucket} device=${nextEntry.deviceName} status=${nextEntry.status} room=${nextEntry.roomId || '-'}`,
      )

      await this.state.storage.put('devices', devices)
      await this.state.storage.setAlarm(now + PRESENCE_TTL_MS)

      return json({
        networkBucket,
        devices: Object.values(devices)
          .filter((entry) => entry?.deviceId && entry.deviceId !== trimmedDeviceId)
          .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0)),
      })
    }

    if (request.method === 'DELETE') {
      const body = await request.json().catch(() => null)
      const deviceId = String(body?.deviceId ?? requestedDeviceId ?? '').trim()

      if (deviceId) {
        delete devices[deviceId]
        await this.state.storage.put('devices', devices)
      }

      return new Response(null, { status: 204, headers: corsHeaders })
    }

    return json({ error: 'Method not allowed' }, 405)
  }

  async alarm() {
    await this.state.storage.deleteAll()
  }
}

export class RoomCoordinator {
  constructor(state) {
    this.state = state
  }

  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders })
    }

    const url = new URL(request.url)
    const roomId = url.pathname.split('/').pop()?.toUpperCase() ?? 'UNKNOWN'
    const room = (await this.state.storage.get('room')) ?? {
      roomId,
      offer: null,
      answer: null,
      updatedAt: null,
    }

    console.log(`[room-do] ${request.method} room=${roomId}`)

    if (request.method === 'GET') {
      return json(room)
    }

    if (request.method === 'POST') {
      const body = await request.json().catch(() => null)

      if (!body?.type || !['offer', 'answer'].includes(body.type) || !body.description) {
        console.warn(`[room-do] invalid payload for room=${roomId}`)
        return json({ error: 'Expected { type, description } payload.' }, 400)
      }

      console.log(
        `[room-do] update room=${roomId} type=${body.type} device=${typeof body.deviceName === 'string' ? body.deviceName.trim().slice(0, 80) : '-'}`,
      )

      const nextRoom = {
        ...room,
        [body.type]: {
          description: body.description,
          deviceName:
            typeof body.deviceName === 'string' ? body.deviceName.trim().slice(0, 80) : '',
          updatedAt: Date.now(),
        },
        updatedAt: Date.now(),
      }

      await this.state.storage.put('room', nextRoom)
      await this.state.storage.setAlarm(Date.now() + 10 * 60 * 1000)

      return json(nextRoom)
    }

    if (request.method === 'DELETE') {
      await this.state.storage.deleteAll()
      return new Response(null, { status: 204, headers: corsHeaders })
    }

    return json({ error: 'Method not allowed' }, 405)
  }

  async alarm() {
    await this.state.storage.deleteAll()
  }
}
