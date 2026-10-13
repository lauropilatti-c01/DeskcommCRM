import { handleJornadas } from "@/lib/c01/jornadas/api";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  return handleJornadas(request, "snapshot");
}
