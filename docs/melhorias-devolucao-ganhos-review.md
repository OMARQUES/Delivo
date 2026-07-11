# Review — Melhorias de devolução e ganhos

Implementado em 2026-07-10 a partir do plano `2026-07-10-melhorias-devolucao-ganhos.md`.

## Correções feitas durante a revisão

1. **Devoluções não dependem do histórico limitado.** Loja e driver usam `scope=returns`, dedicado a devoluções ainda não confirmadas. Sem isso, uma devolução antiga poderia desaparecer atrás do limite de 30 itens do histórico.
2. **Uploads públicos não aceitam SVG.** O plano dizia `image/*`, mas `/media` é público e SVG pode executar conteúdo ativo. Foram permitidos apenas JPEG, PNG e WebP, com limite de 5 MB.
3. **Limite de fotos é atômico.** O `UPDATE` valida `jsonb_array_length < 2`; uploads que perdem uma corrida têm o objeto removido do R2 para não gerar órfãos.
4. **Detalhe financeiro usa projeções explícitas.** Pedido, itens e ledger selecionam somente os campos autorizados. Testes garantem a ausência de endereço, observação, documento e qualquer campo extra do pedido.

## Invariantes preservadas

- A declaração e as fotos do entregador são evidência; não liberam pagamento.
- A confirmação da loja ou do suporte continua sendo o único gatilho do ledger de devolução.
- Só o entregador vinculado ao pedido pode declarar a devolução ou anexar evidência.
- Máximo de duas fotos por pedido, inclusive sob concorrência.

## Carry-forward

As fotos continuam acessíveis por uma chave UUID não-adivinhável via `/media`, sem ACL. O acesso autenticado/assinado deve ser revisto antes do deploy de produção.
