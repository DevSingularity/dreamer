export const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:8000";

// Socket.IO server — see api-server's src/realtime/index.ts (port 9002,
// unchanged from the original prototype's app/demo/page.tsx client).
export const SOCKET_URL =
  process.env.NEXT_PUBLIC_SOCKET_URL || "http://localhost:9002";