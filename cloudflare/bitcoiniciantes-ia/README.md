# Bitcoiniciantes IA

Worker da Cloudflare que oferece a primeira API do Analista IA do EstudeBitcoin.

## Rotas

- `GET /health` confirma que o Worker esta ativo.
- `POST /v1/analyze` recebe `asset`, `period`, `marketData` e `question` e devolve uma analise educativa em portugues.

O Worker usa Gemini como provedor principal e Groq como reserva. Nenhuma chave de IA e armazenada no navegador ou no Git.

## Publicacao

Depois de revisar e registrar o codigo no Git, publique este diretorio no Worker `bitcoiniciantes-ia`. No painel da Cloudflare, configure os segredos `GEMINI_API_KEY` e `GROQ_API_KEY`; eles nunca devem ser colocados no Git ou no codigo do site.