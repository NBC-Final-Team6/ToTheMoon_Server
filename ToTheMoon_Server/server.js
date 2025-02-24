require("dotenv").config(); // 환경 변수 로드
const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const axios = require("axios");
const WebSocket = require("ws");
const fs = require("fs");

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Firebase Admin SDK 설정 (Firebase 콘솔에서 생성한 JSON 파일 사용)
const serviceAccount = require("./firebase-adminsdk.json");
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// 저장된 사용자 요청 (지정가 알림 트리거)
let priceAlerts = [];

// 심볼 통일 함수 (BTC_KRW, KRW-BTC, btc_krw → BTC)
const normalizeSymbol = (exchange, symbol) => {
  if (exchange === "bithumb") return symbol.split("_")[0]; // BTC_KRW → BTC
  if (exchange === "upbit") return symbol.split("-")[1];   // KRW-BTC → BTC
  if (exchange === "coinone") return symbol.toUpperCase(); // btc → BTC
  if (exchange === "korbit") return symbol.split("_")[0].toUpperCase(); // btc_krw → BTC
  return symbol; // 기본적으로 그대로 반환
};

// 모든 거래 가능한 코인 목록 가져오기
const fetchBithumbMarkets = async () => {
    try {
      const response = await axios.get("https://api.bithumb.com/public/ticker/ALL_KRW");
      const data = response.data;
  
      if (data.status !== "0000" || !data.data) {
        throw new Error(`빗썸 API 응답 오류: ${data.message || "데이터 없음"}`);
      }
  
      // `data.data` 객체에서 `date`를 제외한 모든 코인 심볼 추출
      const symbols = Object.keys(data.data).filter(symbol => symbol !== "date");
  
      console.log("빗썸에서 거래 가능한 코인 목록:", symbols);
      return symbols;
    } catch (error) {
      console.error("빗썸 코인 목록 가져오기 실패:", error.message);
      return [];
    }
  };

const setupBithumbWebSocket = async () => {
    const symbols = await fetchBithumbMarkets();
    
    if (symbols.length === 0) {
      console.error("웹소켓 연결 실패: 거래 가능한 코인 목록이 없습니다.");
      return;
    }
  
    // 웹소켓 연결
    const bithumbWS = new WebSocket("wss://pubwss.bithumb.com/pub/ws");
  
    bithumbWS.on("open", () => {
      console.log("빗썸 웹소켓 연결됨");
  
      // 모든 코인 구독
      bithumbWS.send(JSON.stringify({
        symbols: symbols.map(sym => `${sym}_KRW`),  // BTC → BTC_KRW
        tickTypes: ["24H"],
        type: "ticker"
      }));
    });
  
    bithumbWS.on("message", (data) => {
      try {
        const message = JSON.parse(data.toString());
  
        if (message.type === "ticker" && message.content) {
          const symbol = normalizeSymbol("bithumb", message.content.symbol);
          const closePrice = parseFloat(message.content.closePrice);
  
         // console.log(`📊 빗썸 ${symbol} 가격 업데이트: ${closePrice}원`);
          checkPriceAlerts("bithumb", symbol, closePrice);
        }
      } catch (error) {
        console.error("빗썸 데이터 처리 오류:", error);
      }
    });
  
    bithumbWS.on("error", (error) => console.error("빗썸 웹소켓 오류:", error));
  };
  
  // 서버 시작 시 웹소켓 설정
  setupBithumbWebSocket();

// 모든 거래 가능한 업비트 코인 목록 가져오기
const fetchUpbitMarkets = async () => {
    try {
      const response = await axios.get("https://api.upbit.com/v1/market/all");
      const data = response.data;
  
      // "KRW-" 마켓만 필터링하여 코인 리스트 추출
      const symbols = data
        .filter(market => market.market.startsWith("KRW-"))
        .map(market => market.market);
  
      console.log("업비트에서 거래 가능한 코인 목록:", symbols);
      return symbols;
    } catch (error) {
      console.error("업비트 코인 목록 가져오기 실패:", error.message);
      return [];
    }
  };

// 업비트 웹소켓 연결
const setupUpbitWebSocket = async () => {
    const symbols = await fetchUpbitMarkets();
  
    if (symbols.length === 0) {
      console.error("웹소켓 연결 실패: 거래 가능한 코인 목록이 없습니다.");
      return;
    }
  
    const upbitWS = new WebSocket("wss://api.upbit.com/websocket/v1");
  
    upbitWS.on("open", () => {
      console.log("업비트 웹소켓 연결됨");
  
      // 모든 코인 구독
      upbitWS.send(JSON.stringify([
        { ticket: "UNIQUE_TICKET_ID" },
        {
          type: "ticker",
          codes: symbols, // 모든 KRW-XXX 코인 리스트 사용
          isOnlyRealtime: true
        }
      ]));
    });
  
    upbitWS.on("message", async (data) => {
      try {
        const message = JSON.parse(data.toString("utf8"));
  
        if (message.type === "ticker" && message.trade_price) {
          const symbol = normalizeSymbol("upbit", message.code);
          //console.log(`업비트 ${symbol} 가격 업데이트: ${message.trade_price}원`);
          checkPriceAlerts("upbit", symbol, parseFloat(message.trade_price));
        }
      } catch (error) {
        console.error("업비트 데이터 처리 오류:", error);
      }
    });
  
    upbitWS.on("error", (error) => console.error("업비트 웹소켓 오류:", error));
  };
  
  // 서버 시작 시 웹소켓 설정
  setupUpbitWebSocket();

// 모든 거래 가능한 코인원 코인 목록 가져오기
const fetchCoinoneMarkets = async () => {
    try {
      const response = await axios.get("https://api.coinone.co.kr/public/v2/ticker_new/KRW?additional_data=true");
      const data = response.data;
  
      if (!data.tickers) {
        throw new Error("코인원 API 응답 오류: 데이터 없음");
      }
  
      // "KRW-" 마켓만 필터링하여 코인 리스트 추출
      const symbols = data.tickers.map(ticker => ticker.target_currency.toUpperCase());
  
      console.log("코인원에서 거래 가능한 코인 목록:", symbols);
      return symbols;
    } catch (error) {
      console.error("코인원 코인 목록 가져오기 실패:", error.message);
      return [];
    }
  };

// 코인원 웹소켓 연결
const setupCoinoneWebSocket = async () => {
    // 코인원 거래 가능한 코인 목록 가져오기
    const symbols = await fetchCoinoneMarkets();
  
    if (symbols.length === 0) {
      console.error("웹소켓 연결 실패: 거래 가능한 코인 목록이 없습니다.");
      return;
    }
  
    const coinoneWS = new WebSocket("wss://stream.coinone.co.kr");
  
    coinoneWS.on("open", () => {
      console.log("코인원 웹소켓 연결됨");
  
      // 모든 코인에 대해 개별 구독 메시지 전송
      symbols.forEach((symbol) => {
        const subscribeMessage = {
          topic: { target_currency: symbol, quote_currency: "KRW" },
          request_type: "SUBSCRIBE",
          channel: "TICKER"
        };
  
        coinoneWS.send(JSON.stringify(subscribeMessage));
        console.log(`구독 요청 전송됨: ${symbol}`);
      });
    });
  
    coinoneWS.on("message", async (data) => {
      try {
        const message = JSON.parse(data.toString());
  
        if (message.response_type === "CONNECTED" || message.response_type === "SUBSCRIBED") {
          console.log(`코인원 웹소켓 상태: ${message.response_type}`);
          return;
        }
  
        if (message.response_type === "DATA" && message.channel === "TICKER" && message.data) {
          const symbol = message.data.target_currency.toUpperCase();
          const price = parseFloat(message.data.last);
  
          //console.log(`코인원 ${symbol} 가격 업데이트: ${price}원`);
          checkPriceAlerts("coinone", symbol, price);
        }
      } catch (error) {
        console.error("코인원 데이터 처리 오류:", error);
      }
    });
  
    coinoneWS.on("error", (error) => console.error("코인원 웹소켓 오류:", error));
  };
  
  // 서버 시작 시 웹소켓 설정
  setupCoinoneWebSocket();

// 모든 거래 가능한 코빗 코인 목록 가져오기
const fetchKorbitMarkets = async () => {
  try {
    const response = await axios.get("https://api.korbit.co.kr/v1/ticker/detailed/all");
    const data = response.data;

    if (!data) {
      throw new Error("코빗 API 응답 오류: 데이터 없음");
    }

    // 모든 코인 심볼을 배열로 추출하여 KRW-마켓만 필터링
    const symbols = Object.keys(data)
      .filter(symbol => symbol.endsWith("_krw")) // KRW 마켓만 가져오기
      .map(symbol => symbol.toLowerCase()); // 소문자로 변환

    console.log("코빗에서 거래 가능한 코인 목록:", symbols);
    return symbols;
  } catch (error) {
    console.error("코빗 코인 목록 가져오기 실패:", error.message);
    return [];
  }
};

// 코빗 웹소켓 연결
const setupKorbitWebSocket = async () => {
    // 코빗 거래 가능한 코인 목록 가져오기
    const symbols = await fetchKorbitMarkets();
  
    if (symbols.length === 0) {
      console.error("웹소켓 연결 실패: 거래 가능한 코인 목록이 없습니다.");
      return;
    }
  
    const korbitWS = new WebSocket("wss://ws-api.korbit.co.kr/v2/ws");
  
    korbitWS.on("open", () => {
      console.log("코빗 웹소켓 연결됨");
  
      // 모든 코인 구독 메시지 전송
      const subscribeMessage = [
        {
          method: "subscribe",
          type: "ticker",
          symbols: symbols // 모든 KRW 코인 리스트
        }
      ];
  
      korbitWS.send(JSON.stringify(subscribeMessage));
      console.log(`코빗 ${symbols.length}개 코인 구독 요청 완료`);
    });
  
    korbitWS.on("message", async (data) => {
      try {
        const message = JSON.parse(data.toString());
  
        if (message.snapshot) {
          console.log("코빗 초기 데이터 스냅샷 수신, 무시");
          return;
        }
  
        if (message.type === "ticker" && message.data && message.data.close) {
          const symbol = message.symbol.toUpperCase();
          const price = parseFloat(message.data.close);
  
          //console.log(`코빗 ${symbol} 가격 업데이트: ${price}원`);
          checkPriceAlerts("korbit", symbol, price);
        }
      } catch (error) {
        console.error("코빗 데이터 처리 오류:", error);
      }
    });
  
    korbitWS.on("error", (error) => console.error("코빗 웹소켓 오류:", error));
  };
  
  // 서버 시작 시 웹소켓 설정
  setupKorbitWebSocket();

  // 지정가 알림 요청 API
  app.post("/alerts", (req, res) => {
    const { exchange, coin, price, condition, fcmToken } = req.body;

    if (!exchange || !coin || !price || !condition || !fcmToken) {
        return res.status(400).json({ error: "필수 파라미터 누락" });
    }

    if (condition !== "above" && condition !== "below") {
        return res.status(400).json({ error: "condition은 'above' 또는 'below'이어야 합니다." });
    }

    priceAlerts.push({
        exchange: exchange.toLowerCase(),  // 소문자로 변환
        coin,
        price: parseFloat(price),
        condition,
        fcmToken
    });

    console.log(`알림 등록: ${exchange.toLowerCase()} ${coin} ${condition} ${price}원`);

    res.status(201).json({ message: "알림이 성공적으로 등록되었습니다." });
});

// 특정 가격 도달 시 푸시 알림 전송
const checkPriceAlerts = (exchange, coin, currentPrice) => {
  console.log(`${exchange} ${coin} 현재 가격: ${currentPrice}원`);
  console.log(`등록된 알림들:`, priceAlerts);

  priceAlerts = priceAlerts.filter(alert => {
      if (
          alert.exchange === exchange &&
          alert.coin === coin &&
          ((alert.condition === "above" && currentPrice >= alert.price) ||
           (alert.condition === "below" && currentPrice <= alert.price))
      ) {
          console.log(`푸시 알림 트리거됨! ${exchange} ${coin} ${currentPrice}원`);

          sendPushNotification(
              alert.fcmToken,
              `📢 ${exchange.toUpperCase()} ${coin}이(가) ${alert.condition === "above" ? "이상" : "이하"} ${alert.price}원 도달!`
          );
          return false; // 알림 보냈으므로 제거
      }
      return true;
  });
};

// Firebase 푸시 알림 발송 함수
const sendPushNotification = async (token, message) => {
  if (!token) {
      console.error("FCM 토큰이 누락되었습니다!");
      return;
  }

  const payload = {
      token,  // 필수: 푸시를 보낼 FCM 토큰
      notification: {
          title: "투더문 알림",
          body: message
      },
      apns: {
          payload: {
              aps: {
                  alert: {
                      title: "투더문 알림",
                      body: message
                  },
                  sound: "default",  // 알림 사운드 설정
              }
          },
          headers: {
              "apns-priority": "10",
              "apns-push-type": "alert",
              "apns-expiration": "0",  // 즉시 전송
              "apns-topic": "com.tothemoon"  // 앱 번들 ID와 정확히 일치해야 함
          }
      }
  };

  try {
      const response = await admin.messaging().send(payload);
      console.log("푸시 알림 전송 성공:", response);
  } catch (error) {
      console.error("푸시 알림 전송 실패:", error);
  }
};

sendPushNotification("eC2fgsyvjEFqga835CsxjJ:APA91bH6FnPO87W4W1RkXsVl4wGuixiAxr1IMethG100nHWU2SnHtUmVpboESfhX8fJftDmgfiNzteKukLewijHbPq2QPZdCXQsE_ZKrWFIocdRMgPpNm5Y", "푸시 알림 테스트 메시지");

// 서버 실행
app.listen(port, "0.0.0.0", () => {
    console.log(`To The Moon 서버가 http://localhost:${port} 에서 실행 중입니다.`);
  });