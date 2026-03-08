import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';

const BIO_API_URL = process.env.BIO_API_URL!;
const BIO_API_SECRET = process.env.BIO_API_SECRET!;
const RETURN_URL = process.env.RETURN_URL!;

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
};

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  // Warmer ping from EventBridge — exit immediately
  if (!(event as unknown as Record<string, unknown>).requestContext) {
    return { statusCode: 200, body: 'warm' };
  }

  if (event.requestContext.http.method === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  const route = `${event.requestContext.http.method} ${event.rawPath}`;

  if (route === 'POST /api/session') {
    return createSession();
  }

  if (route === 'POST /api/verify') {
    return verifyToken(event);
  }

  return {
    statusCode: 404,
    headers: { ...CORS_HEADERS, 'content-type': 'application/json' },
    body: JSON.stringify({ error: 'Not found' }),
  };
}

async function verifyToken(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  try {
    const body = JSON.parse(event.body || '{}');
    const token = body.token;
    if (!token) {
      return {
        statusCode: 400,
        headers: { ...CORS_HEADERS, 'content-type': 'application/json' },
        body: JSON.stringify({ error: 'Token required' }),
      };
    }

    const res = await fetch(`${BIO_API_URL}/v1/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: BIO_API_SECRET, response: token }),
    });

    const data = await res.json();

    return {
      statusCode: res.status,
      headers: { ...CORS_HEADERS, 'content-type': 'application/json' },
      body: JSON.stringify(data),
    };
  } catch {
    return {
      statusCode: 502,
      headers: { ...CORS_HEADERS, 'content-type': 'application/json' },
      body: JSON.stringify({ error: 'Verification failed' }),
    };
  }
}

async function createSession(): Promise<APIGatewayProxyResultV2> {
  try {
    const res = await fetch(`${BIO_API_URL}/v1/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        secret: BIO_API_SECRET,
        returnUrl: RETURN_URL,
      }),
    });

    const data = await res.json();

    return {
      statusCode: res.status,
      headers: { ...CORS_HEADERS, 'content-type': 'application/json' },
      body: JSON.stringify(data),
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers: { ...CORS_HEADERS, 'content-type': 'application/json' },
      body: JSON.stringify({ error: 'Failed to create session' }),
    };
  }
}
