# Requisitos Funcionais — Plataforma de Delivery para Cidade Pequena

**Data:** 2026-07-06
**Status:** aprovado em brainstorming (16 decisões + ~22 defaults validados com o dono do produto; benchmark: aiqfome)

## 1. Visão

Plataforma de delivery enxuta para cidades pequenas (~12k habitantes). Três superfícies:

- **Web (SPA única, por papel):** cliente compra; loja gerencia produtos/pedidos; admin gerencia a plataforma. Deep-link `dominio.com.br/:storeSlug` abre direto o catálogo da loja (divulgado no Instagram/WhatsApp da loja).
- **App do entregador:** Android (Capacitor), recebe alertas FCM, gerencia coletas e entregas, abre endereços no Waze/Maps.
- **API:** Cloudflare Workers (Hono + Drizzle + Neon). Sem WebSocket no MVP: polling (15-30s) + FCM.

## 2. Atores

| Ator | Acesso | Resumo |
|---|---|---|
| Cliente | Web, conta obrigatória mínima | Navega, pede, paga, acompanha |
| Loja | Web (`/loja`) | Catálogo, pedidos, financeiro, solicita entregador |
| Entregador | App Android | Recebe alertas, aceita, coleta, entrega; freelance ou vinculado a uma loja |
| Admin (plataforma) | Web (`/admin`) | Cadastra/aprova lojas e entregadores, faturas, bloqueios, suporte |

## 3. Contas e identidade

- **Cliente:** cadastro mínimo — nome + WhatsApp + (senha ou Google). Endereço (com pin no mapa) só no primeiro checkout. OTP SMS/WhatsApp: pós-MVP.
- **Loja:** cadastrada pelo admin no MVP (self-service pós-MVP).
- **Entregador:** cadastro no app, **aprovação manual do admin** antes de ativar.
- Sessão: JWT + refresh token. RBAC por papel.

## 4. Catálogo (loja)

- Loja tem: nome, slug único, **categoria de loja** (pizza, lanche, farmácia, mercado...), endereço + pin, telefone/WhatsApp, horário de funcionamento por dia da semana, botão **"pausar pedidos agora"**, configuração de entrega (ver §6), modo de entrega (entregador próprio e/ou freelance), **tempo estimado** (range de entrega, ex. 40-60 min, e de retirada, ex. 20-30 min — exibidos no catálogo e no pedido), **pedido mínimo** (opcional, exclui frete).
- Produtos organizados em **categorias** (da loja), com **ordenação manual** de categorias e produtos. Produto: nome, descrição, preço, foto (R2), disponível/indisponível.
- **Variações** (ex.: tamanho P/M/G — escolha obrigatória de 1, altera preço) e **adicionais** (ex.: catupiry +R$4 — opcionais, múltiplos, com min/max por grupo).
- **Multi-sabor (meio-a-meio):** produto pode ter grupo de sabores com escolha de N (ex.: pizza 2 sabores, min 1 / max 2). **Preço = sabor mais caro.** Combinável com variações e adicionais (meio-a-meio + tamanho + borda recheada). Sabor pode ter preço por variação (matriz sabor×tamanho, fallback preço único) — detalhamento no plano de catálogo.
- **Estoque MVP = toggle** disponível/indisponível por produto, variação e sabor. Contagem numérica: plano ERP, pós-MVP.
- Fora do horário / pausada: catálogo visível, checkout bloqueado com aviso.

### 4.1 Descoberta (home do cliente)

- Home: lojas agrupadas/filtráveis por categoria de loja, indicador aberto/fechado (abertas primeiro), busca por nome de loja.
- **Busca global de produto**: "brigadeiro" retorna produtos de todas as lojas (agrupados por loja). Implementação: Postgres full-text + `pg_trgm`, sem serviço externo.

## 5. Pedido — ciclo de vida

### 5.1 Estados

```
AWAITING_PAYMENT → PENDING → ACCEPTED → PREPARING → READY → AWAITING_DRIVER → OUT_FOR_DELIVERY → DELIVERED
                                                        └───────────────────→ OUT_FOR_DELIVERY   (loja entrega ela mesma)
                                                        └───────────────────→ DELIVERED          (retirada no balcão)
OUT_FOR_DELIVERY → DELIVERY_FAILED   (cliente não atende / endereço errado / recusou pagar)
CANCELLED alcançável de: AWAITING_PAYMENT, PENDING, ACCEPTED, PREPARING, READY, AWAITING_DRIVER
```

- Pagamento **online**: pedido nasce `AWAITING_PAYMENT`; só aparece pra loja após confirmação (webhook Asaas). PIX expira em **15 min** → auto-cancel. Cartão recusado: cliente pode tentar de novo dentro da janela de 15 min.
- Pagamento **na entrega**: pedido nasce direto `PENDING` (registra: dinheiro + "troco para quanto?" ou maquininha).
- `DELIVERED`, `CANCELLED` e `DELIVERY_FAILED` são terminais.
- Todo evento de status é registrado com timestamp e autor (histórico do pedido).
- **Itens do pedido são snapshot**: nome, preço, variação, sabores e adicionais congelados no momento do checkout. Cada item aceita **observação em texto livre** ("sem cebola"); pedido tem observação geral.
- **Checkout revalida tudo server-side** (preço, disponibilidade, loja aberta/pausada, pedido mínimo, raio de entrega) e usa **idempotency key** — duplo clique não cria dois pedidos.

### 5.2 Timeouts e falhas (Cron Trigger + re-notificação)

| Situação | Comportamento |
|---|---|
| Loja não confirma | Re-notifica aos 10 e 20 min; **auto-cancel aos 30 min** + estorno automático se pago + aviso ao cliente |
| PIX não pago | Expira 15 min → auto-cancel |
| Nenhum entregador aceita | Re-broadcast a cada 3-5 min; **aos 10 min alerta a loja**, que decide: seguir esperando / entregar ela mesma (`AWAITING_DRIVER→OUT_FOR_DELIVERY`) / cancelar com estorno |

### 5.3 Cancelamento pelo cliente

- Em `PENDING` (e `AWAITING_PAYMENT`): cancela sozinho no app; estorno automático se pago.
- De `ACCEPTED` em diante: vira **solicitação de cancelamento** — loja aprova (cancela + estorno) ou nega.
- `OUT_FOR_DELIVERY`: sem cancelamento pelo app.

### 5.4 Alteração de pedido (item em falta)

- Loja propõe alteração (remover/substituir item, novo total) → cliente recebe pra **aprovar/recusar no app**.
- Aprovou: pedido segue no status atual com itens/total novos; **estorno parcial automático** se pago online.
- Recusou: cancela tudo com estorno integral.
- Modelado como `order_amendment` (entidade paralela com status própria) — **não** é estado da máquina principal. Um amendment pendente por vez; expira se não respondido até o pedido sair.

### 5.5 Retirada no balcão

- Checkout tem `fulfillment: DELIVERY | PICKUP`.
- `PICKUP`: frete zero, sem endereço, pula dispatch; loja marca `READY→DELIVERED` quando cliente busca.

### 5.6 Entrega falha

- Entregador marca **"não consegui entregar"** com motivo (não atende / endereço errado / recusou pagar / outro) → `OUT_FOR_DELIVERY→DELIVERY_FAILED`; produto **retorna à loja**.
- **Frete do entregador é mantido** no ledger — a viagem foi feita.
- Prejuízo do produto: pedido cash = da loja; pedido online = sem estorno automático, suporte decide caso a caso (campo `resolution` no pedido registra o desfecho).
- Reentrega (2ª tentativa): pós-MVP — se combinarem, loja cria fluxo por fora.

## 6. Entrega e frete

- **Endereço do cliente:** texto (rua, número, bairro, referência) + **pin no mapa** (Leaflet + OpenStreetMap, sem API paga). Pin é obrigatório; endereços salvos no perfil.
- **Frete por loja, dois modos** (loja escolhe):
  - `FIXED`: valor único.
  - `DISTANCE`: valor mínimo + R$/km, distância **haversine** (linha reta) do pin da loja ao pin do cliente, arredondada pra cima em passos de 0,5 km. Sem API de rotas. **Raio máximo opcional** — endereço fora do raio: entrega bloqueada, só retirada.
- Frete calculado e **congelado no checkout** (mudança de tabela não afeta pedido feito).
- Comissão da plataforma **não incide sobre frete** (§8).

## 7. Dispatch (entregador)

### 7.1 Alerta e aceite

- Loja sem entregador próprio (ou com ele ocupado) solicita entregador: pedido entra em `AWAITING_DRIVER` e dispara **broadcast FCM para todos os entregadores disponíveis** da cidade.
- **Primeiro que aceita leva.** Aceite com lock atômico:

```sql
UPDATE orders SET driver_id = :driver, driver_assigned_at = now()
WHERE id = :order AND driver_id IS NULL AND status = 'AWAITING_DRIVER';
-- 0 linhas afetadas → "pedido já foi pego"
```

- Entregador marca **disponível/indisponível**; só disponível recebe broadcast. Continua recebendo alertas mesmo com entregas ativas.

### 7.2 Acúmulo de entregas (batching)

- Entregador pode aceitar **vários pedidos simultâneos, de lojas diferentes, para destinos diferentes**. Ex.: 2 pedidos na farmácia + 1 na pizzaria + 1 no mercado, depois entrega nos 4 endereços.
- **Aceite ≠ coleta.** Pedido aceito permanece `AWAITING_DRIVER` com `driver_id` setado (UI mostra "entregador a caminho da loja"). Vira `OUT_FOR_DELIVERY` quando o entregador marca **"coletei"** na loja — por pedido, individualmente.
- App do entregador = **lista de entregas ativas**, agrupada por loja (fase de coleta) e por destino (fase de entrega). Cada item: dados do pedido, loja, cliente, botões Waze (loja/cliente), marcar coletado, marcar entregue.
- **Ordem da rota é decisão do entregador.** Sem otimização de rota, sem GPS em tempo real no MVP.
- Sem código de retirada no MVP: a loja vê quem aceitou (nome/foto) e entrega em mãos.
- Entregador vinculado a loja: loja pode **atribuir direto** a ele (sem broadcast); ele também pode atuar como freelance se marcado disponível.

### 7.3 Desistência

- Entregador pode **liberar** um pedido aceito antes de coletar → volta a `AWAITING_DRIVER` sem driver, re-broadcast. Após coletar, não libera pelo app (resolve com loja/suporte).

## 8. Dinheiro

### 8.1 Formas de pagamento

- **Online:** PIX e cartão via Asaas (webhook confirma). 
- **Na entrega:** dinheiro (campo "troco para quanto?") ou maquininha da loja levada pelo entregador.

### 8.2 Comissão da plataforma

- **% sobre o subtotal de produtos** (não sobre frete). Percentual configurável por loja (default global).
- Pedido **online**: comissão retida automaticamente no **split Asaas**.
- Pedido **na entrega**: comissão vira **débito da loja** no ledger → consolidada em **fatura periódica** (cobrança Asaas). Inadimplência → **bloqueio manual** da loja pelo suporte/admin.

### 8.3 Fluxo do dinheiro em pagamento na entrega (freelance)

- Entregador recebe do cliente (dinheiro/maquininha) e **entrega o valor integral à loja** no acerto do dia (inclusive frete cobrado).
- O **frete do entregador não fica com ele na hora**: entra como crédito no ledger dele.
- Loja fica devendo à plataforma: comissão + fretes dos pedidos cash entregues por freelance (a plataforma repassa o frete ao entregador no payout).
- Risco aceito: divergência de caixa → loja inadimplente → bloqueio manual.

### 8.4 Payout do entregador

- **Fluxo único:** todo frete (online ou cash) vira crédito no ledger do entregador; plataforma paga **semanalmente via PIX**. Extrato no app.

### 8.5 Ledger

- Toda movimentação por pedido gera lançamentos imutáveis: comissão plataforma, frete a repassar, débito loja, estorno. Fatura e payout são agregações do ledger. **Registrado desde o dia 1**, mesmo se comissão começar zerada.

### 8.6 Estornos

- Cancelamento de pedido pago online → estorno automático via Asaas (integral ou parcial no amendment). Lançamentos de reversão no ledger.

## 9. Notificações

| Evento | Canal |
|---|---|
| Novo pedido / re-alerta → loja | FCM web/push + som no painel (aba aberta) + polling |
| Broadcast entrega → entregadores disponíveis | FCM (app Android, alta prioridade) |
| Status do pedido → cliente | Sem push no MVP: cliente reabre o link (polling). WhatsApp: pós-MVP |
| Amendment / cancelamento → cliente | Mesma regra acima |

- Contato humano: botões **WhatsApp/ligar** entre cliente ↔ loja ↔ entregador nas telas de pedido.

## 10. Painel da loja

- Fila de pedidos por status com ação de avançar (máquina de estados valida transição).
- Solicitar entregador / atribuir entregador próprio / marcar "eu entrego".
- Gestão de catálogo (categorias, produtos, variações, adicionais, sabores/meio-a-meio, fotos, disponibilidade, ordenação).
- Horário + pausar pedidos + tempo estimado + pedido mínimo.
- Financeiro: vendas do dia/período, comissões, fatura em aberto, histórico de pedidos.
- Propor amendment; aprovar/negar solicitação de cancelamento.
- **Versão imprimível** do pedido (print do navegador) — impressora térmica: pós-MVP.
- **Anti-trote**: badge "1º pedido" em cliente novo + telefone visível pra confirmar por ligação antes de aceitar.
- Login: **1 conta por loja** no MVP (multiusuário pós-MVP).

## 11. Admin da plataforma

- CRUD de lojas (cria conta, define % comissão), aprovação de entregadores.
- Faturas de comissão (gerar, acompanhar, marcar paga), payouts semanais (gerar lote, marcar pago).
- Bloqueio/desbloqueio de **loja, entregador e cliente** (trote). Loja bloqueada: pedidos em andamento terminam, novos são impedidos.
- Visão geral: pedidos do dia, GMV, comissões, entregas falhas.

## 12. Regras transversais

- **Timezone fixa** `America/Sao_Paulo` (cidade única).
- **Nota fiscal de venda é responsabilidade da loja** — a plataforma não emite documento fiscal da venda, apenas da própria comissão.
- Rate limiting básico na API (por IP/usuário) nas rotas de escrita.
- **LGPD**: política de privacidade + aceite no cadastro; dados pessoais mínimos; exclusão de conta anonimiza cliente mantendo pedidos (base fiscal/financeira).

## 13. Fora do MVP (explícito)

Agendamento de pedido · avaliações/notas · cupons/promoções · chat in-app · otimização de rota · GPS em tempo real · contagem de estoque · self-service de loja · OTP SMS/WhatsApp · notificação WhatsApp automática · código de retirada · app iOS · impressora térmica · repetir pedido (1 clique) · reentrega pós-falha · multiusuário por loja · auto-accept de pedidos · preço promocional/riscado.

## 14. Impactos técnicos já mapeados

- `packages/shared`: máquina de estados ganha `AWAITING_PAYMENT`, `DELIVERY_FAILED` e transições `READY→OUT_FOR_DELIVERY` / `READY→DELIVERED` (pickup) / `OUT_FOR_DELIVERY→DELIVERY_FAILED`; labels novos. Plano de fundação (Task 2) deve incorporar.
- Frontend web: Leaflet + OSM no cadastro de endereço e no cadastro da loja (pin).
- Busca global de produto: Postgres full-text + `pg_trgm` (índice GIN) — sem serviço externo.
- Modelagem de catálogo: grupos de opções cobrem variação, adicional e **sabor (meio-a-meio, preço = mais caro, matriz sabor×variação)**.
- Novos módulos financeiros (ledger, fatura, payout) — plano próprio no roadmap, junto ou após Pagamentos.
- Cron Triggers: expiração PIX (15min), timeout loja (30min), re-broadcast (3-5min), alerta loja sem entregador (10min), fechamento semanal de payout.
- Checkout: idempotency key + revalidação server-side completa.
- Roadmap de planos revisado: 2. Auth · 3. Catálogo (inclui meio-a-meio e busca) · 4. Pedidos (estados, amendment, cancelamento, pickup, entrega falha) · 5. Dispatch (broadcast, lock, batching) · 6. Pagamentos Asaas (split, estorno) · 7. Financeiro (ledger, fatura, payout) · 8. Capacitor/FCM · 9. Admin & Relatórios.
