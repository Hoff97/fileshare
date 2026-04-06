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
