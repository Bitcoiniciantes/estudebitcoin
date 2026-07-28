"use client";
import { useEffect, useMemo, useState } from "react";

type Signal=[string,string,number,string,string];
type Candle={time:number;open:number;high:number;low:number;close:number;volume:number};
type MarketData={asset:string;pair:string;source:string;updatedAt:number;candles:Candle[]};
type BiasItem={asset:string;score:number;confidence:number;change:number};
type StaticSnapshot={source:string;updatedAt:number;periods:Record<string,Candle[]>};
const fallbackSignals:Signal[] = [
  ["Aguardando mercado","Sem dados suficientes",0,"Dados","Os sinais serão calculados quando os candles reais forem carregados."],
];
const fallbackCandles=Array(32).fill(50);
const defaults=["BTC","ETH","LINK","AVAX","SOL","MSTR","PRATA","COBRE","URANIO"];
const staticAssets:Record<string,{file:string;currency:string}>={MSTR:{file:"mstr",currency:"USD"},PRATA:{file:"prata",currency:"USD"},COBRE:{file:"cobre",currency:"USD"},URANIO:{file:"uranio",currency:"USD"}};
const displayNames:Record<string,string>={PRATA:"PRATA",COBRE:"COBRE",URANIO:"URÂNIO"};
const displayAsset=(asset:string)=>displayNames[asset]??asset;
const intervals:Record<string,string>={"1H":"1h","4H":"4h","1D":"1d","1S":"1w","1M":"1M"};
async function fetchStaticAsset(asset:string,period:string,signal?:AbortSignal):Promise<MarketData>{
 const config=staticAssets[asset];
 if(!config)throw new Error("Ativo pré-cadastrado não localizado");
 const basePath=typeof window!=="undefined"&&window.location.pathname.startsWith("/termometro")?"/termometro":"";
 const response=await fetch(`${basePath}/data/${config.file}.json?v=${Math.floor(Date.now()/60000)}`,{signal,cache:"no-store"});
 if(!response.ok)throw new Error(`Dados de ${displayAsset(asset)} temporariamente indisponíveis`);
 const snapshot:StaticSnapshot=await response.json(),candles=snapshot.periods[period]??[];
 if(candles.length<55)throw new Error(`Histórico de ${displayAsset(asset)} insuficiente em ${period}`);
 return{asset,pair:`${asset}/${config.currency}`,source:snapshot.source,updatedAt:snapshot.updatedAt,candles};
}
async function fetchMarket(asset:string,period:string,signal?:AbortSignal):Promise<MarketData>{
 if(staticAssets[asset])return fetchStaticAsset(asset,period,signal);
 const symbol=`${asset}USDT`,url=`https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=${intervals[period]||"1d"}&limit=120`;
 const response=await fetch(url,{signal}),body=await response.json();
 if(!response.ok)throw new Error(body.msg||"Ativo não disponível na Binance");
 const candles:Candle[]=body.map((row:(string|number)[])=>({time:Number(row[0]),open:Number(row[1]),high:Number(row[2]),low:Number(row[3]),close:Number(row[4]),volume:Number(row[5])}));
 return{asset,pair:`${asset}/USDT`,source:"Binance Public Market Data",updatedAt:Date.now(),candles};
}
const avg=(v:number[])=>v.reduce((a,b)=>a+b,0)/Math.max(v.length,1);
function freshnessLabel(updatedAt:number|undefined,now:number){if(!updatedAt||!now)return 'ÚLTIMA CONSULTA';const seconds=Math.max(0,Math.floor((now-updatedAt)/1000));if(seconds<60)return `ÚLTIMA CONSULTA HÁ ${seconds}s`;const minutes=Math.floor(seconds/60);if(minutes<60)return `ÚLTIMA CONSULTA HÁ ${minutes}min`;return `ÚLTIMA CONSULTA ÀS ${new Date(updatedAt).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'})}`}
function analyze(data:MarketData|null):{signals:Signal[];score:number;confidence:number;change:number}|null{
 if(!data||data.candles.length<55)return null; const c=data.candles, closes=c.map(x=>x.close), last=closes.at(-1)!;
 const sma20=avg(closes.slice(-20)),sma50=avg(closes.slice(-50));
 const deltas=closes.slice(-15).map((x,i)=>x-closes[closes.length-16+i]); const gains=avg(deltas.map(x=>Math.max(x,0))),losses=avg(deltas.map(x=>Math.max(-x,0))); const rsi=losses===0?100:100-(100/(1+gains/losses));
 const vol20=avg(c.slice(-21,-1).map(x=>x.volume)),volRatio=c.at(-1)!.volume/Math.max(vol20,1);
 const atr=avg(c.slice(-14).map((x,i)=>i?Math.max(x.high-x.low,Math.abs(x.high-c[c.length-15+i].close),Math.abs(x.low-c[c.length-15+i].close)):x.high-x.low))/last*100;
 const highs=c.slice(-20).map(x=>x.high),lows=c.slice(-20).map(x=>x.low),compression=(Math.max(...highs.slice(-10))-Math.min(...lows.slice(-10)))/(Math.max(...highs)-Math.min(...lows)); const ascending=avg(lows.slice(-5))>avg(lows.slice(0,5));
 const trend=sma20>sma50?18:-18,momentum=rsi>=55&&rsi<=70?12:rsi>70?-6:rsi<40?-12:2,volume=volRatio>=1.25?12:volRatio<.7?-5:3,pattern=compression<.72?(ascending?18:8):0,risk=atr>7?-12:atr>4?-6:4;
 const signals:Signal[]=[["Tendência primária",`MM20 ${sma20>sma50?"acima":"abaixo"} da MM50`,trend,"Tendência",`MM20: ${sma20.toFixed(2)} • MM50: ${sma50.toFixed(2)}.`],["Compressão de preço",compression<.72?(ascending?"Estrutura ascendente detectada":"Amplitude em contração"):"Sem compressão relevante",pattern,"Padrão",`A amplitude recente equivale a ${(compression*100).toFixed(0)}% da janela de 20 candles.`],["Força relativa",`RSI em ${rsi.toFixed(1)}`,momentum,"Momentum","RSI de 14 períodos calculado pelos fechamentos reais."],["Confirmação por volume",`${volRatio.toFixed(2)}× a média`,volume,"Volume","Volume do candle atual comparado à média dos 20 anteriores."],["Risco por volatilidade",`ATR em ${atr.toFixed(2)}%`,risk,"Risco","ATR de 14 períodos normalizado pelo preço atual."]];
 const score=Math.max(-100,Math.min(100,signals.reduce((a,s)=>a+s[2],0))),agreement=signals.filter(s=>Math.sign(s[2])===Math.sign(score)).length/signals.length; return{signals,score,confidence:Math.round(55+agreement*35),change:(last/closes.at(-2)!-1)*100};
}

export function Termometro(){
 const [ticker,setTicker]=useState("BTC"),[query,setQuery]=useState(""),[period,setPeriod]=useState("1S"),[open,setOpen]=useState<number|null>(1),[assets,setAssets]=useState<string[]>(()=>{if(typeof window==="undefined")return defaults;try{const stored:string[]|null=JSON.parse(localStorage.getItem("termometro-assets")||"null");return stored?[...new Set([...defaults,...stored])]:defaults}catch{return defaults}});
 const [market,setMarket]=useState<MarketData|null>(null),[loading,setLoading]=useState(true),[marketError,setMarketError]=useState("");
 const [ranking,setRanking]=useState<BiasItem[]>([]);
 const [clock,setClock]=useState(0);
 useEffect(()=>{setClock(Date.now());const timer=window.setInterval(()=>setClock(Date.now()),1000);return()=>window.clearInterval(timer)},[]);
 const [previousReading,setPreviousReading]=useState<{period:string;score:number}|null>(null);
 const [lastComparedPeriod,setLastComparedPeriod]=useState('1S');
 useEffect(()=>{setPreviousReading(null);setLastComparedPeriod(period)},[ticker]);
 const [usingCached,setUsingCached]=useState(false);
 useEffect(()=>{setUsingCached(false)},[ticker,period]);
 useEffect(()=>{if(!market||market.asset!==ticker)return;try{localStorage.setItem(`termometro-market-${ticker}-${period}`,JSON.stringify(market))}catch{}},[market,ticker,period]);
 useEffect(()=>{if(!marketError)return;try{const saved=localStorage.getItem(`termometro-market-${ticker}-${period}`),cached:MarketData|null=saved?JSON.parse(saved):null;if(cached&&cached.candles.length>=55){setMarket(cached);setUsingCached(true)}}catch{}},[marketError,ticker,period]);
 const retryMarket=()=>{setLoading(true);setMarketError('');setUsingCached(false);fetchMarket(ticker,period).then(data=>{setMarket(data);setMarketError('')}).catch(e=>{setMarketError(e instanceof Error&&e.message?e.message:'A fonte de dados ainda não respondeu.');setUsingCached(!!market)}).finally(()=>setLoading(false))};
 const [periodFeedback,setPeriodFeedback]=useState(""),[showPeriodHelp,setShowPeriodHelp]=useState(false);
 useEffect(()=>{const controller=new AbortController();fetchMarket(ticker,period,controller.signal).then(data=>{setMarket(data);setPeriodFeedback(current=>current?("✓ Termômetro atualizado para "+period):"")}).catch(e=>{if(e.name!=="AbortError"){setMarket(null);setMarketError(staticAssets[ticker]?`Dados de ${displayAsset(ticker)} temporariamente indisponíveis`:"Ativo indisponível ou bloqueado pela fonte")}}).finally(()=>setLoading(false));return()=>controller.abort()},[ticker,period]);
 useEffect(()=>{const controller=new AbortController();Promise.allSettled(assets.map(asset=>fetchMarket(asset,period,controller.signal))).then(results=>{const next=results.flatMap(result=>{if(result.status!=="fulfilled")return[];const reading=analyze(result.value);return reading?[{asset:result.value.asset,score:reading.score,confidence:reading.confidence,change:reading.change}]:[]});setRanking(next.sort((a,b)=>b.score-a.score))});return()=>controller.abort()},[assets,period]);
 const changePeriod=(nextPeriod:string)=>{if(nextPeriod===period){setPeriodFeedback("✓ "+nextPeriod+" já está selecionado");return}setLoading(true);setMarketError("");setPeriodFeedback("Atualizando termômetro para "+nextPeriod+"…");setPeriod(nextPeriod)};
 useEffect(()=>{if(!periodFeedback)return;const timer=window.setTimeout(()=>setPeriodFeedback(""),3200);return()=>window.clearTimeout(timer)},[periodFeedback]);
 const selectAsset=(asset:string)=>{setLoading(true);setMarketError("");setTicker(asset)};
 const cleanAsset=(value:string)=>value.trim().normalize("NFD").replace(/[\u0300-\u036f]/g,"").toUpperCase().replace(/[^A-Z0-9.-]/g,"");
 const closeKeyboard=()=>{if(typeof document!=="undefined"&&document.activeElement instanceof HTMLElement)document.activeElement.blur()};
 const analyzeQuery=()=>{const clean=cleanAsset(query);if(clean){selectAsset(clean);setQuery("");closeKeyboard()}};
 const includeAsset=()=>{const clean=cleanAsset(query);if(!clean)return;const next=assets.includes(clean)?assets:[...assets,clean];setAssets(next);localStorage.setItem("termometro-assets",JSON.stringify(next));selectAsset(clean);setQuery("");closeKeyboard()};
 const removeAsset=(asset:string)=>{if(defaults.includes(asset))return;const next=assets.filter(item=>item!==asset);setAssets(next);localStorage.setItem("termometro-assets",JSON.stringify(next));if(ticker===asset)selectAsset(next[0]||"BTC")};
 const analysis=useMemo(()=>analyze(market),[market]);
 useEffect(()=>{if(!periodFeedback.startsWith('Atualizando'))return;const currentReading=analyze(market);if(currentReading)setPreviousReading({period:lastComparedPeriod,score:currentReading.score});setLastComparedPeriod(period)},[periodFeedback]);
 const signals=analysis?.signals??fallbackSignals,score=analysis?.score??0,confidence=analysis?.confidence??0,change=analysis?.change??0;
 const candleValues=market?.candles.slice(-32).map(x=>x.close)??fallbackCandles;
 const minC=Math.min(...candleValues),maxC=Math.max(...candleValues),candleHeights=candleValues.map(x=>20+((x-minC)/Math.max(maxC-minC,1))*65);
 const currentPrice=market?.candles.at(-1)?.close;
 const recent=market?.candles.slice(-21,-1)??[],resistance=recent.length?Math.max(...recent.map(x=>x.high)):0,support=recent.length?Math.min(...recent.map(x=>x.low)):0;
 const tr=market?.candles.slice(-15).map((x,i,a)=>i?Math.max(x.high-x.low,Math.abs(x.high-a[i-1].close),Math.abs(x.low-a[i-1].close)):x.high-x.low)??[];
 const atrAbs=tr.length?avg(tr.slice(-14)):0,entry=resistance?resistance*1.002:0,stop=entry&&atrAbs?entry-atrAbs*1.5:0,target=entry&&stop?entry+(entry-stop)*2.5:0;
 const volumeRatio=market&&market.candles.length>21?market.candles.at(-1)!.volume/avg(market.candles.slice(-21,-1).map(x=>x.volume)):0;
 const currency=staticAssets[ticker]?.currency??"USDT";
 const displayName=displayAsset(ticker);
 const fmt=(value:number|undefined)=>value?`${currency} ${value.toLocaleString("pt-BR",{minimumFractionDigits:2,maximumFractionDigits:2})}`:"—";
 const pct=(value:number)=>currentPrice&&value?`${value>=currentPrice?"+":""}${((value/currentPrice-1)*100).toFixed(2)}%`:"—"; const entryDistance=currentPrice&&entry?(entry/currentPrice-1)*100:0,supportDistance=currentPrice&&support?(support/currentPrice-1)*100:0;
 const showPlan=!!analysis&&score>=20&&entryDistance<=15;
 const planStatus=!analysis?"SEM DADOS":score<=-20?"PRESSÃO DE VENDA":score<20?"AGUARDAR":entryDistance>15?"GATILHO DISTANTE":entryDistance>5?"EM OBSERVAÇÃO":"PRÓXIMO DO GATILHO";
 const planTone=score<=-20?"sell":score<20||entryDistance>15?"wait":"ready";
 const planMessage=!analysis?"Aguardando dados suficientes.":score<=-20?"Plano de compra suspenso: pressão vendedora predominante.":score<20?"Leitura neutra. Nenhuma entrada válida neste momento.":entryDistance>15?`Rompimento a ${entryDistance.toFixed(2)}% do preço atual; cenário ainda distante.`:entryDistance>5?`Ativo a ${entryDistance.toFixed(2)}% do gatilho; mantenha em observação.`:"Gatilho próximo; aguarde confirmação do fechamento.";
 const patternTitle=analysis&&signals[1][2]>0?signals[1][1]:"Sem padrão confirmado";
 const label=score>=55?"COMPRA FORTE":score>=20?"COMPRA":score>-20?"NEUTRO":score>-55?"VENDA":"VENDA FORTE";
 const toneClass=score>=20?"tonePositive":score<=-20?"toneNegative":"toneNeutral";
 const radarItems=useMemo(()=>[...ranking.map(item=>({...item,available:true})),...assets.filter(asset=>!ranking.some(item=>item.asset===asset)).map(asset=>({asset,score:0,confidence:0,change:0,available:false}))],[ranking,assets]);
 const sourceLabel=staticAssets[ticker]?'YAHOO FINANCE':'BINANCE',freshnessBase=freshnessLabel(market?.updatedAt,clock),freshness=staticAssets[ticker]?freshnessBase.replace('ÚLTIMA CONSULTA','DADO ATUALIZADO'):freshnessBase;
 return <main>
  <div className='marketFreshness'><span className='sourceStatus'><i/>{loading?'BUSCANDO MERCADO':marketError?'FONTE INDISPONÍVEL':sourceLabel}</span>{!loading&&market&&<span className='freshness'>{freshness}</span>}<button type='button' onClick={retryMarket} disabled={loading} aria-label='Consultar dados novamente' title='Consultar dados novamente'>↻</button></div>
  <header><a className="brand" href="https://bitcoiniciantes.github.io/estudebitcoin/" target="_blank" rel="noopener noreferrer" title="Abrir Estude Bitcoin"><b>T°</b><span>TERMÔMETRO<small>ESTUDE BITCOIN ↗</small></span></a><nav><a href="#painel">Painel</a><a href="#metodo">Metodologia</a><a href="#regras">Regras</a></nav><span className="live"><i/> {loading?"BUSCANDO MERCADO":marketError?"FONTE INDISPONÍVEL":staticAssets[ticker]?`${displayName} • YAHOO FINANCE`:"DADOS REAIS • BINANCE"}</span></header>
  <section className="analysisDesk workspace" id="painel">
  <div className="analysisColumn analysisLeft">
    <div className="workspaceMain">
    <div className="deskTop">
      <div className="deskAsset"><span className="assetIcon">{displayName.slice(0,2)}</span><div><span className="eyebrow">ATIVO EM ANÁLISE</span><h1>{displayName}<small>/{currency}</small></h1></div></div>
      <div className="deskQuote"><span>ÚLTIMO PREÇO</span><b>{fmt(currentPrice)}</b><small className={change<0?"down":""}>{analysis?`${change>=0?"+":""}${change.toFixed(2)}% no candle`:marketError||"Carregando..."}</small></div>
      <div className={`quickScale ${loading?"isLoading":""}`} role="img" aria-label={`Viés rápido: ${loading?"carregando":score}`}><div className="quickScaleHead"><span>VIÉS RÁPIDO</span><b>{loading?"CARREGANDO":`${score>0?"+":""}${score}`}</b></div><div className="quickScaleTrack"><i style={{left:loading?"50%":`${(score+100)/2}%`}}/></div><div className="quickScaleLabels"><span>-100<br/>Venda</span><span>0<br/>Neutro</span><span>+100<br/>Compra</span></div></div>
      <div className="desktopPeriodPrompt"><div className="desktopPeriodGuide"><div><span>ESCOLHA O PERÍODO</span><button type="button" onClick={()=>setShowPeriodHelp(value=>!value)} aria-expanded={showPeriodHelp} aria-label="Explicar períodos">i</button></div><small>O resultado muda conforme o período.</small>{showPeriodHelp&&<p>Períodos curtos reagem mais rápido e têm mais ruído. Períodos longos mostram tendências mais consistentes.</p>}</div><div className="periods">{["1H","4H","1D","1S","1M"].map(p=><button key={p} onClick={()=>changePeriod(p)} className={period===p?"active":""} aria-label={`Consultar período ${p}`}>{p}</button>)}</div>{periodFeedback&&<div className={`desktopPeriodFeedback ${periodFeedback.startsWith("✓")?"done":""}`} role="status" aria-live="polite">{periodFeedback}</div>}</div>
    </div>
    {previousReading&&!loading&&<div className='desktopPeriodComparison'><PeriodComparison previous={previousReading} current={{period,score}}/></div>}
    <div className='mobileTopPeriods'><span>PERÍODO DA ANÁLISE</span><div className='periods'>{['1H','4H','1D','1S','1M'].map(p=><button key={p} onClick={()=>changePeriod(p)} className={period===p?'active':''} aria-label={`Consultar período ${p}`}>{p}</button>)}</div>{periodFeedback&&<small role='status' aria-live='polite'>{periodFeedback}</small>}</div>
    {previousReading&&!loading&&<div className='mobilePeriodComparison'><PeriodComparison previous={previousReading} current={{period,score}}/></div>}
    {marketError&&<div className={'marketRecovery '+(usingCached?'cached':'failed')} role='alert'><div><b>{usingCached?'DADO SALVO':'NÃO FOI POSSÍVEL ATUALIZAR'}</b><span>{usingCached?'A fonte não respondeu. Exibindo o último dado salvo.':marketError}{usingCached&&market?.updatedAt?` Atualizado em ${new Date(market.updatedAt).toLocaleString('pt-BR')}.`:''}</span></div><button type='button' onClick={retryMarket} disabled={loading}>{loading?'Tentando…':'Tentar novamente'}</button></div>}
    <form className="assetSearch" onSubmit={e=>{e.preventDefault();analyzeQuery()}}><label>BUSCAR ATIVO</label><div><input aria-label="Código do ativo" value={query} onChange={e=>setQuery(e.target.value)} placeholder="BTC" type="search" enterKeyHint="search" autoCapitalize="characters" spellCheck={false} autoComplete="off" onKeyDown={e=>{if(e.key==="Enter"){e.preventDefault();analyzeQuery();e.currentTarget.blur()}}}/><button type="submit">Analisar</button><button type="button" className="includeButton" onClick={includeAsset}>+ Incluir</button></div></form>
    <div className="biasBoard"><div className="biasHead"><span>RADAR COMPRA × VENDA</span><small>Viés comparativo em {period}</small></div><div className="biasList">{radarItems.map((item,index)=>{const side=!item.available?"SEM DADOS":item.score>=20?"COMPRA":item.score<=-20?"VENDA":"NEUTRO";return <div key={item.asset} className={`biasItem ${side.toLowerCase().replace(" ","-")} ${ticker===item.asset?"selected":""}`}><button className="biasSelect" onClick={()=>selectAsset(item.asset)}><span className="biasRank">{index+1}</span><b>{displayAsset(item.asset)}</b><span className="biasSide">{side}</span><strong>{item.available?`${item.score>0?"+":""}${item.score}`:"—"}</strong><i><em style={{width:`${item.available?Math.abs(item.score):0}%`}}/></i></button>{!defaults.includes(item.asset)&&<button className="biasRemove" onClick={()=>removeAsset(item.asset)} aria-label={`Remover ${displayAsset(item.asset)}`} title={`Remover ${displayAsset(item.asset)}`}>×</button>}</div>})}</div><p>Viés técnico comparativo; não representa ordem de entrada.</p></div>
  </div>
    <article className="card chart"><Title kicker="ESTRUTURA DE PREÇO" title={patternTitle} extra={<span className="badge">CONFIANÇA {confidence}%</span>}/><div className="priceChart"><div className="chartIdentity"><b>{displayName}</b><span>{period} · CANDLES REAIS</span></div><div className="resistance"><span>RESISTÊNCIA {fmt(resistance)}</span></div><div className="support"><span>SUPORTE {fmt(support)}</span></div><div className="candles">{candleHeights.map((h,i)=><i key={i} className={i%4===0||i%7===0?"red":"green"} style={{height:`${h}%`,transform:`translateY(${i%3*5}px)`}}><b/></i>)}</div></div><div className="chartFoot"><span><i className="dot greenDot"/>MM20</span><span><i className="dot blueDot"/>MM50</span><span>Volume <b>{volumeRatio?`${volumeRatio.toFixed(2)}× média`:"—"}</b></span><span className="chartPurpose">Mostra a estrutura usada na nota: candles, suporte e resistência.</span></div></article>
  </div>
  <div className="analysisColumn analysisRight">
    <article className={`card thermo heroThermo thermoTone ${toneClass}`}><div className="mobilePeriods periodPrompt"><div className="periodGuide"><div><span>ESCOLHA O PERÍODO DA ANÁLISE</span><button type="button" onClick={()=>setShowPeriodHelp(value=>!value)} aria-expanded={showPeriodHelp} aria-label="Explicar períodos">i</button></div><small>O resultado muda conforme o período.</small>{showPeriodHelp&&<p>Períodos curtos reagem mais rápido e têm mais ruído. Períodos longos mostram tendências mais consistentes.</p>}</div><div className="periods">{["1H","4H","1D","1S","1M"].map(p=><button key={p} onClick={()=>changePeriod(p)} className={period===p?"active":""} aria-label={`Consultar período ${p}`}>{p}</button>)}</div>{periodFeedback&&<div className={`periodFeedback ${periodFeedback.startsWith("✓")?"done":""}`} role="status" aria-live="polite">{periodFeedback}</div>}</div><Title kicker="TERMÔMETRO DO ATIVO" title={loading?`Carregando ${displayName}…`:`Leitura consolidada · ${displayName}`} extra={<button className="info" title="Regras fixas, sem IA">i</button>}/><div className="scoreRing" style={{"--score":`${(score+100)*1.8}deg`} as React.CSSProperties}><div><b>{score>0?"+":""}{score}</b><span>DE 100</span></div></div><h3>{label}</h3><p>{score>=20?"Convergência positiva, com risco controlado.":score<=-20?"Pressão vendedora predominante; evite antecipar reversão.":"Sinais mistos: aguarde confirmação."}</p><div className="scale"><div className="scaleTrack"><i style={{left:`${(score+100)/2}%`}}/></div><div><span>-100<br/>Venda</span><span>0<br/>Neutro</span><span>+100<br/>Compra</span></div></div><div className="confidence"><span>Confiança da leitura</span><b>{confidence}%</b><div><i style={{width:`${confidence}%`}}/></div></div></article>
    <article className="card levels"><Title kicker="PLANO TÉCNICO" title="Cenário condicional"/><div className={`planStatus ${planTone}`}><span>STATUS DO CENÁRIO</span><b>{planStatus}</b><p>{planMessage}</p></div>{showPlan?<><div className="level target"><span>ALVO PROJETADO</span><b>{fmt(target)}</b><small>{pct(target)}</small></div><div className="level entry"><span>ROMPIMENTO / ENTRADA CONDICIONAL</span><b>{fmt(entry)}</b><small>{entryDistance.toFixed(2)}% do preço atual</small></div><div className="level stop"><span>INVALIDAÇÃO / STOP APÓS ENTRADA</span><b>{fmt(stop)}</b><small>{pct(stop)}</small></div><div className="risk"><span>RISCO : RETORNO</span><b>{entry&&stop?"1 : 2,5":"—"}</b></div></>:<><div className="level currentLevel"><span>PREÇO ATUAL</span><b>{fmt(currentPrice)}</b><small>referência</small></div><div className={`level ${score<=-20?"stop":"entry"}`}><span>{score<=-20?"SUPORTE DE REFERÊNCIA":"RESISTÊNCIA DE REFERÊNCIA"}</span><b>{fmt(score<=-20?support:resistance)}</b><small>{score<=-20?pct(support):pct(resistance)}</small></div><div className="distanceNote"><span>{score<=-20?"DISTÂNCIA ATÉ O SUPORTE":"DISTÂNCIA ATÉ O ROMPIMENTO"}</span><b>{score<=-20?`${supportDistance.toFixed(2)}%`:`${entryDistance.toFixed(2)}%`}</b></div></>}<p className="disclaimer">Níveis usam candles concluídos, estrutura e ATR. Conteúdo educacional, não é recomendação.</p></article>
  </div>
  <article className="card signals" id="regras"><Title kicker="RAIO-X DA NOTA" title={`${signals.length} sinais ativos`} extra={<span className="sum">SOMA: <b>{score>0?"+":""}{score}</b></span>}/><div className="signalList">{signals.map((s,i)=><button key={s[0]} onClick={()=>setOpen(open===i?null:i)} className={open===i?"opened":""}><span className={`sign ${s[2]>0?"positive":"negative"}`}>{s[2]>0?"+":""}{s[2]}</span><span className="signalText"><b>{s[0]}</b><small>{s[1]}</small>{open===i&&<em>{s[4]}</em>}</span><span className="group">{s[3]}</span><span className="chev">›</span></button>)}</div></article>
</section>
  <section className="method" id="metodo"><div><span className="eyebrow">COMO A NOTA NASCE</span><h2>Sem palpite.<br/>Sem caixa-preta.</h2></div><div className="methodSteps">{[["01","Detectamos","Pivôs, linhas, compressões e padrões geométricos."],["02","Confirmamos","Momentum, tendência, volume e volatilidade validam o cenário."],["03","Pontuamos","Cada regra soma ou subtrai pontos com pesos públicos."],["04","Explicamos","Você audita cada ponto e sabe o que muda a leitura."]].map(x=><div key={x[0]}><b>{x[0]}</b><h3>{x[1]}</h3><p>{x[2]}</p></div>)}</div></section>
  <footer><span><b>T°</b> TERMÔMETRO</span><p>Ferramenta educacional • Motor determinístico • Sem IA</p><small>PILOTO v0.1</small></footer>
 </main>
}
function PeriodComparison({previous,current}:{previous:{period:string;score:number};current:{period:string;score:number}}){const state=(score:number)=>score>=20?{label:'COMPRA',tone:'buy'}:score<=-20?{label:'VENDA',tone:'sell'}:{label:'NEUTRO',tone:'neutral'},before=state(previous.score),after=state(current.score),signed=(score:number)=>`${score>0?'+':''}${score}`;return <div className='periodComparison' role='status' aria-live='polite'><span className={'periodState '+before.tone}><b>{before.label}</b><strong>{signed(previous.score)}</strong><small>{previous.period}</small></span><i aria-hidden='true'>→</i><span className={'periodState '+after.tone}><b>{after.label}</b><strong>{signed(current.score)}</strong><small>{current.period}</small></span></div>}
export default function Home(){return <Termometro/>}
function Title({kicker,title,extra}:{kicker:string,title:string,extra?:React.ReactNode}){return <div className="cardTitle"><div><span>{kicker}</span><b>{title}</b></div>{extra}</div>}
