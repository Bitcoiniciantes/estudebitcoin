# Publicar o EstudeBitcoin no Cloudflare Pages

1. Abra o Cloudflare e entre em **Workers & Pages**.
2. Clique em **Create application** e depois em **Pages > Connect to Git**.
3. Conecte a conta do GitHub e selecione o repositório `estudebitcoin`.
4. Use estas configurações:

   - **Project name:** `estudebitcoin` ou outro nome disponível
   - **Production branch:** `main`
   - **Framework preset:** `None`
   - **Build command:** deixe vazio
   - **Build output directory:** `/`

5. Clique em **Save and Deploy**.

O endereço será parecido com `https://estudebitcoin.pages.dev`.

## Se o repositório ficar privado

O site continuará público no endereço `.pages.dev`. No Cloudflare Pages, mantenha o aplicativo do GitHub autorizado a acessar o repositório privado. Novos pushes na branch `main` continuarão acionando novas publicações.

## Observação sobre a API

O site usa o Worker `bitcoiniciantes-ia` para algumas funções. As chaves de IA permanecem somente nos segredos do Worker e não devem ser adicionadas a este repositório.
