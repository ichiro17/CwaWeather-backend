require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 3000;

// CWA API 設定
const CWA_API_BASE_URL = "https://opendata.cwa.gov.tw/api";
const CWA_API_KEY = process.env.CWA_API_KEY;

// 快取設定
const CACHE_DURATION = 30 * 60 * 1000; // 30 分鐘
const weatherCache = new Map();

// 定義支援的城市與對應的中文名稱 (六都)
const CITY_MAP = {
  tainan: "臺南市",
  kaohsiung: "高雄市",
  taichung: "臺中市",
  taipei: "臺北市",
  taoyuan: "桃園市",
  newtaipei: "新北市",
};

// Middleware - 改進的 CORS 設定
const allowedOrigins = process.env.ALLOWED_ORIGINS 
  ? process.env.ALLOWED_ORIGINS.split(',') 
  : '*';

app.use(cors({
  origin: allowedOrigins,
  methods: ['GET'],
  credentials: true
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 日誌中間件
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// 快取管理功能
function getCachedWeather(cityKey) {
  const cached = weatherCache.get(cityKey);
  if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
    return cached.data;
  }
  return null;
}

function setCachedWeather(cityKey, data) {
  weatherCache.set(cityKey, {
    data,
    timestamp: Date.now()
  });
}

/**
 * 取得指定城市天氣預報
 * CWA 氣象資料開放平臺 API
 * 使用「一般天氣預報-今明 36 小時天氣預報」資料集
 */
const getCityWeather = async (req, res) => {
  const startTime = Date.now();
  
  try {
    const { city } = req.params;
    
    // 驗證城市是否在支援列表中 (轉小寫比對)
    const locationName = CITY_MAP[city.toLowerCase()];

    if (!locationName) {
      return res.status(400).json({
        success: false,
        error: "不支援的城市",
        message: `請輸入有效的城市代碼: ${Object.keys(CITY_MAP).join(", ")}`,
      });
    }

    // 檢查是否有設定 API Key
    if (!CWA_API_KEY) {
      console.error("[ERROR] CWA_API_KEY 未設定");
      return res.status(500).json({
        success: false,
        error: "伺服器設定錯誤",
        message: "請在 .env 檔案中設定 CWA_API_KEY",
      });
    }

    // 呼叫 CWA API
    const response = await axios.get(
      `${CWA_API_BASE_URL}/v1/rest/datastore/F-C0032-001`,
      {
        headers: {
          'Authorization': CWA_API_KEY,
        },
        params: {
          locationName: locationName,
        },
        timeout: 8000,
      }
    );

    // 取得該城市的天氣資料
    const locationData = response.data.records.location[0];

    if (!locationData) {
      return res.status(404).json({
        success: false,
        error: "查無資料",
        message: `無法取得 ${locationName} 天氣資料`,
      });
    }

    // 整理天氣資料
    const weatherData = {
      city: locationData.locationName,
      cityKey: city.toLowerCase(),
      updateTime: response.data.records.datasetDescription,
      forecasts: [],
    };

    // 解析天氣要素
    const weatherElements = locationData.weatherElement;
    const timeCount = weatherElements[0].time.length;

    for (let i = 0; i < timeCount; i++) {
      const forecast = {
        startTime: weatherElements[0].time[i].startTime,
        endTime: weatherElements[0].time[i].endTime,
        weather: "",
        rain: "",
        minTemp: "",
        maxTemp: "",
        comfort: "",
        windSpeed: "",
      };

      weatherElements.forEach((element) => {
        const timeData = element.time[i];
        if (!timeData) return;

        const value = timeData.parameter;
        switch (element.elementName) {
          case "Wx":
            forecast.weather = value.parameterName;
            break;
          case "PoP":
            forecast.rain = value.parameterName;
            break;
          case "MinT":
            forecast.minTemp = value.parameterName;
            break;
          case "MaxT":
            forecast.maxTemp = value.parameterName;
            break;
          case "CI":
            forecast.comfort = value.parameterName;
            break;
          case "WS":
            forecast.windSpeed = value.parameterName;
            break;
        }
      });

      weatherData.forecasts.push(forecast);
    }

    const duration = Date.now() - startTime;
    console.log(`[SUCCESS] ${city} 天氣資料取得成功 (${duration}ms)`);

    res.json({
      success: true,
      data: weatherData,
    });
  } catch (error) {
    const duration = Date.now() - startTime;
    
    // 詳細的錯誤日誌
    console.error("[ERROR] 取得天氣資料失敗:", {
      city: req.params.city,
      error: error.message,
      code: error.code,
      status: error.response?.status,
      duration: `${duration}ms`,
      timestamp: new Date().toISOString(),
    });

    // 根據錯誤類型返回適當的狀態碼
    if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
      return res.status(504).json({
        success: false,
        error: "請求超時",
        message: "CWA API 回應時間過長，請稍後再試",
      });
    }

    if (error.response) {
      return res.status(error.response.status).json({
        success: false,
        error: "CWA API 錯誤",
        message: error.response.data.message || "無法取得天氣資料",
        details: error.response.data,
      });
    }

    res.status(500).json({
      success: false,
      error: "伺服器錯誤",
      message: "無法取得天氣資料，請稍後再試",
    });
  }
};

// Routes
app.get("/", (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
});

app.get("/api/health", (req, res) => {
  res.json({ 
    status: "OK", 
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

// 設定動態路由，:city 代表變數
app.get("/api/weather/:city", getCityWeather);

// Error handling
app.use((err, req, res, next) => {
  console.error("[ERROR] 未處理的錯誤:", {
    message: err.message,
    stack: err.stack,
    timestamp: new Date().toISOString(),
  });
  
  res.status(500).json({
    success: false,
    error: "伺服器錯誤",
    message: err.message,
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: "找不到此路徑",
    path: req.path,
  });
});

// 優雅關閉
process.on('SIGTERM', () => {
  console.log('收到 SIGTERM 信號,正在關閉伺服器...');
  server.close(() => {
    console.log('伺服器已關閉');
    process.exit(0);
  });
});

const server = app.listen(PORT, () => {
  console.log(`🚀 伺服器運行於 http://localhost:${PORT}`);
  console.log(`📍 支援城市: ${Object.keys(CITY_MAP).join(", ")}`);
  console.log(`📍 環境: ${process.env.NODE_ENV || "development"}`);
  console.log(`📍 CORS 允許來源: ${allowedOrigins === '*' ? '所有來源' : allowedOrigins}`);
});