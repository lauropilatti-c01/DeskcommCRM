import { redirect, notFound } from "next/navigation";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { moduloLigado } from "@/lib/instalacao/modulos";
import Jornadas from "@/components/c01/jornadas/Jornadas";
export const dynamic = "force-dynamic";
export default async function JornadasPage() {
  const authz = await requireRole("viewer", { resource: "c01_jornadas" });
  if (!authz.ok) redirect(authz.response.status === 401 ? "/login" : "/403");
  if (!(await moduloLigado(createAdminClient(), "c01_jornadas"))) notFound();
  return <Jornadas key={authz.org.orgId} />;
}
