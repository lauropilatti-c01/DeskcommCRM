---
impacto: nada_mudou
secao: corrigido
titulo: Envio de texto não oferece vídeo quando a capacidade está desligada
---

A ferramenta de envio oferece `video_chave` somente quando a política válida da
organização habilita vídeos. Texto e fotos do catálogo continuam disponíveis.
Campo de vídeo indevido é recusado, sem transformar a legenda em texto; o erro
orienta uma nova chamada apenas com `body` quando essa era a intenção. Vídeo ligado
continua sendo conferido no catálogo e relido antes do envio. Nenhuma capacidade
é ativada por esta correção. Uma tentativa de envio recusada pelo SDK também
invalida o texto anterior retido por estilo; uma nova tentativa válida continua
podendo usar a saída útil existente.
