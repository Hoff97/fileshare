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

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders })
    }

    const url = new URL(request.url)

    if (url.pathname === '/presence') {
      const networkKey =
        request.headers.get('CF-Connecting-IP') ??
        request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
        'unknown-network'
      const durableObjectId = env.PRESENCE.idFromName(networkKey)
      const presence = env.PRESENCE.get(durableObjectId)

      return presence.fetch(new Request(request, { headers: request.headers }))
    }

    const match = url.pathname.match(/^\/rooms\/([A-Za-z0-9_-]{4,20})$/)

    if (!match) {
      return json({ error: 'Not found' }, 404)
    }

    const roomId = match[1].toUpperCase()
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
    const now = Date.now()
    const requestedDeviceId = (url.searchParams.get('deviceId') ?? '').trim()
    const devices = (await this.state.storage.get('devices')) ?? {}

    for (const [deviceId, entry] of Object.entries(devices)) {
      if (now - (entry?.updatedAt ?? 0) > PRESENCE_TTL_MS) {
        delete devices[deviceId]
      }
    }

    if (request.method === 'GET') {
      await this.state.storage.put('devices', devices)
      return json({
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

      devices[String(body.deviceId).slice(0, 120)] = {
        deviceId: String(body.deviceId).slice(0, 120),
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

      await this.state.storage.put('devices', devices)
      await this.state.storage.setAlarm(now + PRESENCE_TTL_MS)

      return json({
        devices: Object.values(devices)
          .filter((entry) => entry?.deviceId && entry.deviceId !== String(body.deviceId).slice(0, 120))
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

    if (request.method === 'GET') {
      return json(room)
    }

    if (request.method === 'POST') {
      const body = await request.json().catch(() => null)

      if (!body?.type || !['offer', 'answer'].includes(body.type) || !body.description) {
        return json({ error: 'Expected { type, description } payload.' }, 400)
      }

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
