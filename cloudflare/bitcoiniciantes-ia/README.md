# Bitcoiniciantes IA

Worker da Cloudflare que oferece a primeira API do Analista IA do EstudeBitcoin.

## Rotas

- `GET /health` confirma que o Worker esta ativo.
- `POST /v1/analyze` recebe `asset`, `period`, `marketData` e `question` e devolve uma analise educativa em portugues.

O Worker usa o binding `AI` da Cloudflare e o modelo `@cf/openai/gpt-oss-120b`. Nenhuma chave de IA e armazenada no navegador ou no Git.

## Publicacao

Depois de revisar e registrar o codigo no Git, publique este diretorio no Worker `bitcoiniciantes-ia`. No painel da Cloudflare, o binding de Workers AI deve se chamar `AI`.
