// Interface artwork only. Saved games and exported notation remain plain text.
const COLOR_SUITS = Object.freeze({
  CLOVERS: {name:'Clubs', glyph:'♧', path:'M13 21C8 26 1 22 2 16C2 12 6 10 10 11C5 7 8 1 13 1C19 1 21 7 17 11C23 8 28 12 27 17C27 23 20 25 16 21C16 24 18 27 21 29H7C11 27 13 24 13 21Z', shine:'M12 4C8 5 9 9 11 10M5 14C3 18 6 21 9 20'},
  DIAMONDS: {name:'Diamonds', glyph:'◇', path:'M15 1L28 15L15 29L2 15Z', shine:'M15 5L6 15L15 25M6 15H24'},
  SPADES: {name:'Spades', glyph:'♤', path:'M15 1C11 7 2 11 2 18C2 24 10 26 13 21C13 25 11 28 8 29H22C19 27 17 25 17 21C21 26 28 24 28 18C28 11 19 7 15 1Z', shine:'M14 6C9 12 5 14 5 18C5 21 8 22 10 21'},
  HEARTS: {name:'Hearts', glyph:'♡', path:'M15 28C10 23 1 16 1 9C1 0 11-2 15 6C19-2 29 0 29 9C29 16 20 23 15 28Z', shine:'M5 10C4 5 9 3 12 7'},
});
const SUIT_CHARACTERS = Object.freeze({'♧':'CLOVERS','♣':'CLOVERS','◇':'DIAMONDS','♢':'DIAMONDS','♦':'DIAMONDS','♤':'SPADES','♠':'SPADES','♡':'HEARTS','♥':'HEARTS'});
const NOBLE_TITLES = Object.freeze({Rx:'Rex',Dx:'Dux',Vz:'Vizier'});
const GAME_SYMBOLS = /[♧♣◇♢♦♤♠♡♥]|\b(?:Rx|Dx|Vz)\b/g;
const RICH_SYMBOL_SKIP = 'script,style,svg,pre,code,textarea,input,option,[contenteditable="true"],.suit-icon,.noble-rank';

export function suitSymbolHtml(suit) {
  const art=COLOR_SUITS[suit];
  if(!art)return '';
  return `<span class="suit-icon suit-${suit.toLowerCase()}" role="img" aria-label="${art.name}"><svg viewBox="0 0 30 30" aria-hidden="true" focusable="false"><path class="suit-fill" d="${art.path}"/><path class="suit-shine" d="${art.shine}"/></svg><span class="suit-fallback" aria-hidden="true">${art.glyph}</span></span>`;
}

export function gameSymbolDescription(text) {
  return String(text).replace(/\b(Rx|Dx|Vz)([♧♣◇♢♦♤♠♡♥])/g,(_,rank,glyph)=>`${NOBLE_TITLES[rank]} of ${COLOR_SUITS[SUIT_CHARACTERS[glyph]].name}`)
    .replace(/[♧♣◇♢♦♤♠♡♥]/g,glyph=>` ${COLOR_SUITS[SUIT_CHARACTERS[glyph]].name} `).replace(/\s+/g,' ').trim();
}

// Decorate text nodes, never parsed user markup or stored game data.
// Keeping existing elements preserves controls, animation nodes and focus.
export function decorateGameSymbols(root) {
  const doc=root?.ownerDocument;
  if(!doc?.createTreeWalker)return;
  const element=root.nodeType===1?root:root.parentElement;
  if(element?.tagName==='OPTION') {
    if(/[♧♣◇♢♦♤♠♡♥]/.test(element.textContent))element.textContent=gameSymbolDescription(element.textContent);
    return;
  }
  if(!element||element.closest(RICH_SYMBOL_SKIP))return;
  for(const control of [element,...element.querySelectorAll('option,[aria-label],[title]')]) {
    for(const attribute of ['aria-label','title']) {
      const value=control.getAttribute(attribute);
      if(value&&/[♧♣◇♢♦♤♠♡♥]/.test(value))control.setAttribute(attribute,gameSymbolDescription(value));
    }
    if(control.tagName==='OPTION'&&/[♧♣◇♢♦♤♠♡♥]/.test(control.textContent))control.textContent=gameSymbolDescription(control.textContent);
  }
  const nodes=[];
  if(root.nodeType===3)nodes.push(root);
  else {
    const walker=doc.createTreeWalker(root,4);
    while(walker.nextNode())nodes.push(walker.currentNode);
  }
  for(const node of nodes) {
    if(!node.parentElement||node.parentElement.closest(RICH_SYMBOL_SKIP))continue;
    const value=node.nodeValue;
    GAME_SYMBOLS.lastIndex=0;
    const matches=[...value.matchAll(GAME_SYMBOLS)];
    if(!matches.length)continue;
    const fragment=doc.createDocumentFragment();let offset=0;
    for(const match of matches) {
      fragment.append(doc.createTextNode(value.slice(offset,match.index)));
      const token=match[0],span=doc.createElement('span');
      if(SUIT_CHARACTERS[token]) {
        // This is fixed artwork selected by a known suit, never user markup.
        span.innerHTML=suitSymbolHtml(SUIT_CHARACTERS[token]);
        fragment.append(span.firstElementChild);
      } else {
        span.className='noble-rank';span.append(doc.createTextNode(token[0]));
        const lower=doc.createElement('sub');lower.textContent=token[1];span.append(lower);fragment.append(span);
      }
      offset=match.index+token.length;
    }
    fragment.append(doc.createTextNode(value.slice(offset)));node.replaceWith(fragment);
  }
}

export function installGameSymbols(root) {
  const Observer=root?.ownerDocument?.defaultView?.MutationObserver;
  if(!Observer)return;
  decorateGameSymbols(root);
  const observer=new Observer(records=>{
    const changed=new Set();
    for(const record of records) {
      if(record.type==='characterData')changed.add(record.target);
      else for(const node of record.addedNodes)if(node.nodeType===1||node.nodeType===3)changed.add(node);
    }
    for(const node of changed)if(node.isConnected)decorateGameSymbols(node);
  });
  observer.observe(root,{childList:true,subtree:true,characterData:true});
  return ()=>observer.disconnect();
}
