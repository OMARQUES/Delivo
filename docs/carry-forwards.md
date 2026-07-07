# Carry-forwards (pendências técnicas conscientes)

| Item | Origem | Dono futuro |
|---|---|---|
| `updatedAt` via `$onUpdate` é ORM-level; raw SQL bypassa. Avaliar trigger `moddatetime` | Review Task 4 | Plano Financeiro (ledger) |
| Normalizar email (`toLowerCase().trim()`) na escrita; índice `lower(email)` já garante unicidade | Review Task 4 | Plano Auth |
| `/docs` + `/openapi.json` expostos sem gate | Review Task 3 | Task 9 (deploy prod) |
| Slugs reservados (`loja`, `admin`, etc.) — validar na criação de loja | Review Task 5 | Plano Catálogo |
| `@delivery/shared/constants` aponta pra `order-status.ts`; renomear/barril quando 2º módulo chegar | Review Task 7 | Próximo módulo shared |
| `viewport-fit=cover` no index.html do driver (notch Android) | Review Task 6 | Plano Capacitor |
| vitest node pool: rotas que usam `c.env` dependem de mock; avaliar `@cloudflare/vitest-pool-workers` | Reviews Tasks 3/4 | Quando integração real precisar |
| Enforcement do factory `createRouter()` via lint rule (`no-restricted-syntax`) | Review Task 3 | Oportunista |
| Deploy prod (Tasks 9-10 do plano): Neon + Hyperdrive id + secrets + deploy.yml | Skip do usuário | Quando tiver contas |
| Marca dividida: repo "Delivo" vs interno "Delivery" (`@delivery/*`, titles, openapi, worker names) — unificar antes do público | Review final | Antes do deploy prod |
| Barrel `@delivery/shared` (".") re-exporta schema zod — frontend importando barrel puxa zod de volta; considerar `no-restricted-imports` | Review final | Oportunista |
