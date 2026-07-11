# Entrega ponto a ponto por pessoa física — proposta futura

**Data:** 2026-07-11
**Status:** Estacionada; fora do roadmap imediato
**Retomar depois de:** P0 de segurança, staging privado e confiabilidade de pagamentos

## Oportunidade

Permitir que uma pessoa autenticada pague para transportar um pacote pronto entre dois endereços. Exemplos: pequeno vendedor que recebeu pedido por WhatsApp, envio de caneca, documento ou marmita, ou transporte de objeto pessoal até familiar.

Categoria já validada por Uber Envios, 99Entrega e Lalamove. Pode ampliar demanda fora do catálogo de lojas e aproveitar pool geral de entregadores.

## Decisão arquitetural preliminar

Não adaptar diretamente `orders`. Pedido atual exige loja, cliente, catálogo, preparo e pagamento de mercadoria. Criar agregado independente, provisoriamente chamado `shipments`, reutilizando apenas componentes seguros: usuário, entregador, geolocalização, aceite atômico, pagamento, notificações e ledger.

Fluxo preliminar:

```text
DRAFT → QUOTED → AWAITING_PAYMENT → SEARCHING_DRIVER
→ DRIVER_ASSIGNED → AT_PICKUP → PICKED_UP → IN_TRANSIT → DELIVERED

Saídas: CANCELLED | DELIVERY_FAILED → RETURNING → RETURNED
```

## MVP recomendado

- Remetente autenticado com email verificado.
- Transporte pré-pago; venda da mercadoria fica fora da plataforma.
- Uma origem, um destino, mesma cidade, entrega imediata.
- Moto; pacote lacrado, até 10 kg, aproximadamente 40 × 38 × 45 cm.
- Valor declarado máximo inicial de R$500.
- Sem compra assistida, pagamento na entrega, dinheiro ou cobrança do produto.
- PIN distinto na coleta e na entrega; GPS e timestamps como evidência auxiliar.
- Destinatário sem conta, com telefone obrigatório para contato/código e aviso de privacidade.
- Retorno obrigatório quando entrega falhar; preço e responsabilidade informados antes do pagamento.
- Alimento preparado somente lacrado e bem embalado, sem garantia de temperatura.

## Riscos que bloqueiam lançamento sem desenho específico

- Itens ilegais, perigosos, roubados ou falsamente declarados.
- Cartão roubado, chargeback, conluio e entrega simulada.
- Furto, troca, avaria e disputa sobre conteúdo/valor.
- Destinatário ausente ou recusando; devolução, armazenamento e abandono.
- Falsa coleta usada para roubo ou exposição física do entregador.
- Exposição de telefone, endereço e geolocalização de terceiro sem conta.
- Conflito entre entrega P2P, pool geral e turno de loja.
- Regras de motofrete, consumidor, documentação fiscal/conteúdo e normas municipais.
- Seguro, limite de indenização e operação de suporte/disputas.

## Itens proibidos preliminares

Dinheiro, cartões, cheques, joias, armas, drogas, medicamentos controlados, combustíveis, químicos perigosos, animais, pessoas, tabaco, bens roubados ou de origem desconhecida e itens acima dos limites declarados. Lista final exige revisão jurídica e operacional.

## Complexidade preliminar

- Protótipo inseguro: 2–3 semanas; não recomendado.
- MVP controlado: 6–10 semanas de engenharia.
- Produto público robusto: 10–16 semanas, incluindo antifraude, reconciliação, suporte, disputas e compliance.

## Decisões pendentes ao retomar

1. Confirmar escopo estrito do MVP acima.
2. Cidade/estado inicial e requisitos municipais/fiscais.
3. Política de preço, espera, cancelamento e retorno.
4. Limites de valor, peso, dimensões e categorias permitidas.
5. Seguro/indenização e processo de disputa.
6. Evidências de coleta/entrega e retenção LGPD.
7. Regras de concorrência para entregadores em turno ou outra entrega.
8. Critérios antifraude e eventual verificação adicional do remetente.

## Referências iniciais

- [Uber Envios](https://www.uber.com/br/pt-br/item-delivery/)
- [Uber Flash — limites](https://www.uber.com/pt-BR/blog/uber-flash-solicite-viagens-para-enviar-artigos-pessoais-por-meio-do-app-da-uber/)
- [99Entrega](https://99app.com/ajuda/motorista/como-funciona-o-99entrega-e-99entrega-moto/)
- [Lalamove — itens de valor](https://www.lalamove.com/pt-br/itens-de-valor)
- [Lalamove — termos e itens proibidos](https://www.lalamove.com/pt-br/termos-e-condicoes)
- [Lei 12.009/2009 — motofrete](https://www.planalto.gov.br/ccivil_03/_ato2007-2010/2009/lei/l12009.htm)
- [Código de Defesa do Consumidor](https://www.planalto.gov.br/ccivil_03/leis/l8078compilado.htm)
- [ANPD — direitos e dados pessoais](https://www.gov.br/anpd/pt-br/assuntos/titular-de-dados-1)
