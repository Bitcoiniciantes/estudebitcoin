"use client";
import { useMemo, useState } from "react";

const signals = [
  ["Tendência primária","MM20 acima da MM50",16,"Tendência","A média de 20 períodos está acima da média de 50, com ambas inclinadas para cima."],
  ["Triângulo ascendente","Compressão + topos alinhados",20,"Padrão","Foram encontrados 3 testes de resistência e fundos progressivamente mais altos."],
  ["Força relativa","IFR em 61,4",8,"Momentum","Momentum positivo sem entrar na zona de sobrecompra. Faixa ideal configurada: 55–68."],
  ["Confirmação por volume","1,7× a média",13,"Volume","O volume recente supera a média de 20 períodos e fortalece o rompimento."],
  ["Volatilidade elevada","ATR em expansão",-9,"Risco","A amplitude média cresceu 18% em cinco sessões. O risco exige stop mais largo."],
  ["Resistência próxima","Distância de 1,2%",-7,"Estrutura","Há oferta relevante perto do preço atual. A nota melhora após fechamento acima dela."],
] as const;
const candles=[42,46,44,49,47,52,50,55,53,57,54,59,58,62,60,64,61,67,65,70,68,73,71,77,75,80,78,83,81,86,84,89];
const offset=(t:string)=>t.split("").reduce((a,c)=>a+c.charCodeAt(0),0)%23-11;

export default function Home(){
 const [ticker,setTicker]=useState("PETR4"),[query,setQuery]=useState("PETR4"),[period,setPeriod]=useState("1D"),[open,setOpen]=useState<number|null>(1);
 const score=useMemo(()=>Math.max(-100,Math.min(100,signals.reduce((a,s)=>a+s[2],0)+offset(ticker))),[ticker]);
 const confidence=78+Math.abs(offset(ticker)%8),label=score>=55?"COMPRA FORTE":score>=20?"COMPRA":score>-20?"NEUTRO":score>-55?"VENDA":"VENDA FORTE";
 return <main>
  <header><a className="brand"><b>T°</b><span>TERMÔMETRO<small>mercado em leitura</small></span></a><nav><a href="#painel">Painel</a><a href="#metodo">Metodologia</a><a href="#regras">Regras</a></nav><span className="live"><i/> DADOS DE DEMONSTRAÇÃO</span></header>
  <section className="hero" id="painel"><span className="eyebrow">ANÁLISE TÉCNICA • SEM IA • 100% EXPLICÁVEL</span><div className="heroRow"><div><h1>O mercado deixa pistas.<br/><em>Nós medimos a temperatura.</em></h1><p>Convergência de tendência, padrões, momentum, volume e risco em uma única leitura auditável.</p></div><form onSubmit={e=>{e.preventDefault();if(query.trim())setTicker(query.trim().toUpperCase())}}><label>ANALISAR ATIVO</label><div><span>⌕</span><input aria-label="Código do ativo" value={query} onChange={e=>setQuery(e.target.value)} placeholder="Ex.: PETR4"/><button>Analisar →</button></div><small>Experimente PETR4, VALE3, ITUB4 ou BTC-USD</small></form></div></section>
  <section className="dashboard"><div className="assetHead"><div className="identity"><span className="assetIcon">{ticker.slice(0,2)}</span><div><h2>{ticker}</h2><p>{ticker.includes("BTC")?"Bitcoin / Dólar":"Ativo selecionado • B3"}</p></div></div><div className="quote"><b>R$ {(31.46+offset(ticker)/10).toFixed(2).replace(".",",")}</b><span>+1,84% hoje</span></div><div className="periods">{["1H","4H","1D","1S"].map(p=><button key={p} onClick={()=>setPeriod(p)} className={period===p?"active":""}>{p}</button>)}</div><span className="updated">Atualizado agora</span></div>
   <div className="grid">
    <article className="card chart"><Title kicker="ESTRUTURA DE PREÇO" title="Triângulo ascendente detectado" extra={<span className="badge">CONFIANÇA 82%</span>}/><div className="priceChart"><div className="resistance"><span>RESISTÊNCIA 32,10</span></div><div className="support"><span>SUPORTE ASCENDENTE</span></div><div className="candles">{candles.map((h,i)=><i key={i} className={i%4===0||i%7===0?"red":"green"} style={{height:`${18+h/2}%`,transform:`translateY(${i%3*5}px)`}}><b/></i>)}</div></div><div className="chartFoot"><span><i className="dot greenDot"/>MM20</span><span><i className="dot blueDot"/>MM50</span><span>Volume <b>1,7× média</b></span></div></article>
    <article className="card thermo"><Title kicker="TERMÔMETRO DO ATIVO" title="Leitura consolidada" extra={<button className="info" title="Regras fixas, sem IA">i</button>}/><div className="scoreRing" style={{"--score":`${(score+100)*1.8}deg`} as React.CSSProperties}><div><b>{score>0?"+":""}{score}</b><span>DE 100</span></div></div><h3>{label}</h3><p>{score>=20?"Convergência positiva, com risco controlado.":"Sinais mistos: aguarde confirmação."}</p><div className="scale"><div className="scaleTrack"><i style={{left:`${(score+100)/2}%`}}/></div><div><span>-100<br/>Venda</span><span>0<br/>Neutro</span><span>+100<br/>Compra</span></div></div><div className="confidence"><span>Confiança da leitura</span><b>{confidence}%</b><div><i style={{width:`${confidence}%`}}/></div></div></article>
    <article className="card signals" id="regras"><Title kicker="RAIO-X DA NOTA" title="6 sinais ativos" extra={<span className="sum">SOMA: <b>{score>0?"+":""}{score}</b></span>}/><div className="signalList">{signals.map((s,i)=><button key={s[0]} onClick={()=>setOpen(open===i?null:i)} className={open===i?"opened":""}><span className={`sign ${s[2]>0?"positive":"negative"}`}>{s[2]>0?"+":""}{s[2]}</span><span className="signalText"><b>{s[0]}</b><small>{s[1]}</small>{open===i&&<em>{s[4]}</em>}</span><span className="group">{s[3]}</span><span className="chev">›</span></button>)}</div></article>
    <article className="card levels"><Title kicker="PLANO TÉCNICO" title="Cenário de referência"/><div className="level target"><span>ALVO PROJETADO</span><b>R$ 35,20</b><small>+11,9%</small></div><div className="level entry"><span>GATILHO DE ENTRADA</span><b>R$ 32,18</b><small>fechamento</small></div><div className="level stop"><span>INVALIAÇÃO / STOP</span><b>R$ 30,42</b><small>-3,3%</small></div><div className="risk"><span>RISCO : RETORNO</span><b>1 : 3,4</b></div><p className="disclaimer">Níveis calculados por estrutura e ATR. Conteúdo educacional, não é recomendação.</p></article>
   </div>
  </section>
  <section className="method" id="metodo"><div><span className="eyebrow">COMO A NOTA NASCE</span><h2>Sem palpite.<br/>Sem caixa-preta.</h2></div><div className="methodSteps">{[["01","Detectamos","Pivôs, linhas, compressões e padrões geométricos."],["02","Confirmamos","Momentum, tendência, volume e volatilidade validam o cenário."],["03","Pontuamos","Cada regra soma ou subtrai pontos com pesos públicos."],["04","Explicamos","Você audita cada ponto e sabe o que muda a leitura."]].map(x=><div key={x[0]}><b>{x[0]}</b><h3>{x[1]}</h3><p>{x[2]}</p></div>)}</div></section>
  <footer><span><b>T°</b> TERMÔMETRO</span><p>Ferramenta educacional • Motor determinístico • Sem IA</p><small>PILOTO v0.1</small></footer>
 </main>
}
function Title({kicker,title,extra}:{kicker:string,title:string,extra?:React.ReactNode}){return <div className="cardTitle"><div><span>{kicker}</span><b>{title}</b></div>{extra}</div>}
