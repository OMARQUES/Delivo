# Revisão de implementação — Ofertas/Vagas (④c)

Implementação concluída com oferta limitada a N vagas, recorrência semanal ou por datas, aceite/dispensa, vínculo confirmado automático e expiração lazy dos vínculos por datas. O aceite reutiliza integralmente turnos e ledger; nenhum cálculo financeiro foi duplicado.

## Correções ao plano original

O lock proposto selecionava apenas ofertas `OPEN`. Ao preencher a última vaga e fechar a oferta no mesmo update, um concorrente bloqueado poderia reavaliar o filtro após acordar e receber 404. O serviço agora bloqueia pelo `id` independentemente do status e distingue oferta inexistente, encerrada e esgotada; o perdedor da corrida recebe 409 `Vagas esgotadas` e toda a transação é revertida em qualquer falha.

Vínculos expirados são tratados como inativos: não entram no conflito nem impedem um novo vínculo com a mesma loja. Desde a evolução para múltiplos vínculos, cada aceite cria um novo registro e preserva os anteriores como histórico. Janelas overnight são comparadas contra o dia adjacente, inclusive nas combinações semanal×data e data×data.

O aceite também bloqueia a linha do usuário. Isso fecha uma segunda corrida ausente no plano: o mesmo entregador aceitar simultaneamente duas ofertas diferentes e ambas validarem uma agenda ainda vazia. O segundo aceite agora reavalia a agenda após o primeiro commit e recebe 409 em caso de conflito.

Ofertas por datas deixam de ser listadas quando todas as datas passaram e o aceite direto é recusado como expirado. Datas históricas de uma recorrência parcialmente passada também são ignoradas no conflito, evitando que uma agenda antiga bloqueie uma vaga futura.

## Limites conscientes

O MVP não implementa regras como “primeira segunda do mês” e não envia push para novas ofertas. Datas e regras de expiração usam `America/Sao_Paulo`, conforme o restante do domínio de turnos.

## Evolução: múltiplos vínculos e ocorrências

O entregador pode ter vários vínculos não sobrepostos, inclusive na mesma loja. O turno referencia `store_driver_id`, congela a ocorrência e permite início apenas entre 30 minutos antes e 30 minutos depois do combinado. Atrasos posteriores exigem autorização excepcional aceita pelo entregador. Vínculos por datas expiram no fim real da última janela, inclusive overnight.

Reajustes de turno ativo também passaram a exigir confirmação. O extra pode valer apenas para próximas entregas ou gerar ajustes retroativos no ledger; a diária aceita substitui o valor integral daquele turno.

O encerramento operacional não credita a diária imediatamente: a loja aprova ou recusa com motivo, e pendências sem decisão são aprovadas automaticamente após 24 horas. A loja também pode liberar a reativação da mesma linha de turno por até 30 minutos, sem gerar uma segunda diária. Extras de entregas concluídas permanecem independentes dessa decisão.
