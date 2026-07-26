import { DurableObject } from "cloudflare:workers";
import type { Env, LatLng } from "./types";
import { fetchRandomStreetPoint, nextRoadPoint, haversineKm } from "./mapillary";

const UPDATE_INTERVAL_MS = 30_000;
const CORRECT_RADIUS_KM = 0.5;
const MAX_ROUNDS = 8;

interface RoomState {
  status: "idle" | "running" | "finished";
  round: number;
  aiPosition: LatLng | null;
  imageUrl: string;
  imageId: string;
  hint: string;
  revealedHints: string[];
  nextUpdateAt: number;
}

const HINT_POOL = [
  "近くに川がある",
  "海岸から近い",
  "山間部を走っている",
  "標識の言語がわかる",
  "気温はおおよそ推測できる",
  "道路の中央線の色が特徴的",
  "近くに大きな交差点がある",
  "建物の密度が高いエリア",
];


// ★追加：捜索範囲設定
const REGION_PRESETS: Record<string, LatLng[]> = {
  tokyo: [
    { lat: 35.681, lng: 139.767 }
  ],

  osaka_kyoto: [
    { lat: 34.694, lng: 135.502 },
    { lat: 35.011, lng: 135.768 }
  ],

  hokkaido: [
    { lat: 43.062, lng: 141.354 }
  ],

  kyushu: [
    { lat: 33.590, lng: 130.401 }
  ],

  japan: [
    { lat: 35.681, lng: 139.767 },
    { lat: 34.694, lng: 135.502 },
    { lat: 35.011, lng: 135.768 },
    { lat: 43.062, lng: 141.354 },
    { lat: 33.590, lng: 130.401 }
  ],

  world: [
    { lat: 35.681, lng: 139.767 },
    { lat: 40.7128, lng: -74.0060 },
    { lat: 51.5074, lng: -0.1278 }
  ]
};


export class GameRoom extends DurableObject<Env> {

  sockets: Set<WebSocket> = new Set();

  gameState: RoomState = {
    status: "idle",
    round: 0,
    aiPosition: null,
    imageUrl: "",
    imageId: "",
    hint: "",
    revealedHints: [],
    nextUpdateAt: 0,
  };


  async fetch(req: Request): Promise<Response> {

    const url = new URL(req.url);


    if (req.headers.get("Upgrade") === "websocket") {

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);

      this.handleSocket(server);

      return new Response(null,{
        status:101,
        webSocket:client
      });
    }


    if (url.pathname.endsWith("/start") && req.method === "POST") {

      // ★追加：地域情報を受け取る
      const body = await req.json().catch(() => ({}));

      await this.startChaseMode(
        body.region ?? "japan"
      );

      return Response.json({
        ok:true,
        state:this.publicState()
      });
    }


    if(url.pathname.endsWith("/state") && req.method==="GET"){
      return Response.json(this.publicState());
    }


    return new Response("not found",{status:404});
  }



  handleSocket(ws:WebSocket){

    ws.accept();

    this.sockets.add(ws);

    ws.send(JSON.stringify({
      type:"state",
      ...this.publicState()
    }));

    ws.addEventListener(
      "message",
      (ev)=>this.onMessage(ws,ev)
    );

    ws.addEventListener(
      "close",
      ()=>this.sockets.delete(ws)
    );

    ws.addEventListener(
      "error",
      ()=>this.sockets.delete(ws)
    );
  }



  async onMessage(ws:WebSocket,ev:MessageEvent){

    let payload:any;

    try{
      payload=JSON.parse(ev.data as string);
    }
    catch{
      return;
    }


    if(payload.type==="guess"){

      await this.handleGuess(
        ws,
        payload.lat,
        payload.lng,
        payload.userId ?? "anon"
      );

    }
  }




  async handleGuess(
    ws:WebSocket,
    lat:number,
    lng:number,
    userId:string
  ){

    if(
      this.gameState.status!=="running" ||
      !this.gameState.aiPosition
    ) return;


    const distanceKm =
      haversineKm(
        {lat,lng},
        this.gameState.aiPosition
      );


    const correct =
      distanceKm <= CORRECT_RADIUS_KM;


    const score =
      correct
      ? Math.max(
          100,
          Math.round(1000-distanceKm*20)
        )
      :0;



    ws.send(JSON.stringify({
      type:"result",
      distanceKm:
        Math.round(distanceKm*100)/100,
      correct,
      score
    }));


    if(correct){

      this.broadcast({
        type:"caught",
        userId,
        round:this.gameState.round
      });

      await this.advanceRoundOrFinish();
    }



    try{

      await this.env.DB.prepare(
        `INSERT INTO guesses
        (id,round_id,user_id,guess_lat,guess_lng,distance_km,score,guessed_at)
        VALUES (?,?,?,?,?,?,?,?)`
      )
      .bind(
        crypto.randomUUID(),
        `${this.ctx.id.toString()}-r${this.gameState.round}`,
        userId,
        lat,
        lng,
        distanceKm,
        score,
        Date.now()
      )
      .run();

    }
    catch(err){

      console.error(
        "D1 write failed",
        err
      );

    }
  }





  // ★変更：地域指定を受け取る
  async startChaseMode(region="japan"){


    const regions =
      REGION_PRESETS[region]
      ?? REGION_PRESETS.japan;


    const center =
      regions[
        Math.floor(
          Math.random()*regions.length
        )
      ];



    const found =
      await fetchRandomStreetPoint(
        this.env.MAPILLARY_TOKEN,
        center
      );



    if(!found){

      this.gameState={
        status:"running",
        round:1,
        aiPosition:center,
        imageUrl:"",
        imageId:"",
        hint:this.pickHint(),
        revealedHints:[],
        nextUpdateAt:
          Date.now()+UPDATE_INTERVAL_MS
      };

    }
    else{


      this.gameState={

        status:"running",

        round:1,

        aiPosition:found.point,

        imageUrl:found.imageUrl,

        imageId:found.imageId,

        hint:this.pickHint(),

        revealedHints:[],

        nextUpdateAt:
          Date.now()+UPDATE_INTERVAL_MS

      };

    }


    this.broadcast({
      type:"state",
      ...this.publicState()
    });


    await this.ctx.storage.setAlarm(
      Date.now()+UPDATE_INTERVAL_MS
    );

  }




  async alarm(){

    if(
      this.gameState.status!=="running" ||
      !this.gameState.aiPosition
    ) return;


    const bearing =
      Math.random()*360;


    const nextPoint =
      await nextRoadPoint(
        this.gameState.aiPosition,
        bearing,
        0.8
      );



    const found =
      await fetchRandomStreetPoint(
        this.env.MAPILLARY_TOKEN,
        nextPoint,
        0.01
      );


    this.gameState.round++;

    this.gameState.aiPosition =
      found
      ? found.point
      : nextPoint;


    if(found){

      this.gameState.imageUrl =
        found.imageUrl;

      this.gameState.imageId =
        found.imageId;

    }


    this.gameState.hint =
      this.pickHint();



    if(this.gameState.round>MAX_ROUNDS){

      this.gameState.status="finished";

      this.broadcast({
        type:"state",
        ...this.publicState()
      });

      return;

    }



    this.gameState.nextUpdateAt =
      Date.now()+UPDATE_INTERVAL_MS;


    this.broadcast({
      type:"state",
      ...this.publicState()
    });


    await this.ctx.storage.setAlarm(
      Date.now()+UPDATE_INTERVAL_MS
    );

  }




  async advanceRoundOrFinish(){

    await this.alarm();

  }




  pickHint(){

    const remaining =
      HINT_POOL.filter(
        h=>!this.gameState.revealedHints.includes(h)
      );


    const hint =
      remaining[
        Math.floor(Math.random()*remaining.length)
      ] ?? HINT_POOL[0];


    this.gameState.revealedHints=[
      ...this.gameState.revealedHints,
      hint
    ];


    return hint;

  }




  broadcast(msg:unknown){

    const data =
      JSON.stringify(msg);


    for(const ws of this.sockets){

      try{

        ws.send(data);

      }
      catch{

        this.sockets.delete(ws);

      }

    }

  }





  publicState(){

    return {

      round:this.gameState.round,

      maxRounds:MAX_ROUNDS,

      imageUrl:this.gameState.imageUrl,

      imageId:this.gameState.imageId,

      hint:this.gameState.hint,

      revealedHints:this.gameState.revealedHints,

      status:this.gameState.status,

      secondsUntilNext:
        Math.max(
          0,
          Math.round(
            (this.gameState.nextUpdateAt-Date.now())
            /1000
          )
        )

    };

  }

}