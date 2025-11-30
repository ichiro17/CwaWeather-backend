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

// 定義支援的城市與對應中文名稱
const CITY_MAP = {
  tainan: "臺南市",
  kaohsiung: "高雄市",
  taichung: "臺中市",
  taipei: "臺北市",
  taoyuan: "桃園市",
  newtaipei: "新北市",
};

// CORS 設定
const allowedOrigins = process.env.ALLOWED_ORIGINS 
  ? process.env.ALLOWED_ORIGINS.split(',') 
  : '*';

app.use(cors({
  origin: allowedOrigins,
  methods: ['GET', 'POST'],
  credentials: true
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 日誌中間件
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// 快取功能
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

// 天氣 API 主程式
const getCityWeather = async (req, res) => {
  const startTime = Date.now();

  try {
    const { city } = req.params;
    console.log(`🔍 請求城市: ${city}`);
    
    const locationName = CITY_MAP[city.toLowerCase()];

    if (!locationName) {
      console.log(`❌ 不支援的城市: ${city}`);
      return res.status(400).json({
        success: false,
        error: "不支援的城市",
        message: `有效城市代碼: ${Object.keys(CITY_MAP).join(", ")}`
      });
    }

    console.log(`📍 查詢城市: ${locationName} (${city})`);

    // 檢查快取
    const cached = getCachedWeather(city.toLowerCase());
    if (cached) {
      console.log(`✅ 從快取返回 ${locationName} 天氣資料`);
      return res.json({ success: true, data: cached, cached: true });
    }

    // API Key 檢查
    if (!CWA_API_KEY) {
      console.error("❌ 缺少 CWA_API_KEY");
      return res.status(500).json({
        success: false,
        message: "伺服器設定錯誤,缺少 CWA_API_KEY",
        hint: "請在環境變數中設定 CWA_API_KEY"
      });
    }

    console.log(`🌐 呼叫 CWA API: ${locationName}`);

    const response = await axios.get(
      `${CWA_API_BASE_URL}/v1/rest/datastore/F-C0032-001`,
      {
        headers: { 'Authorization': CWA_API_KEY },
        params: { locationName },
        timeout: 10000,
      }
    );

    console.log(`✅ CWA API 回應成功 (狀態碼: ${response.status})`);

    // 檢查回應結構
    if (!response.data || !response.data.records || !response.data.records.location) {
      console.error("❌ CWA API 回應格式異常");
      return res.status(500).json({
        success: false,
        message: "CWA API 回應格式異常",
        detail: "無法解析 location 資料"
      });
    }

    const locationData = response.data.records.location[0];

    if (!locationData) {
      console.error(`❌ 查無 ${locationName} 天氣資料`);
      return res.status(404).json({
        success: false,
        message: `查無 ${locationName} 天氣資料`
      });
    }

    console.log(`📊 開始處理 ${locationName} 的天氣資料...`);

    const weatherElements = locationData.weatherElement;

    const weatherData = {
      city: locationData.locationName,
      cityKey: city.toLowerCase(),
      updateTime: response.data.records.datasetDescription,
      forecasts: [],
    };

    const count = weatherElements[0].time.length;

    for (let i = 0; i < count; i++) {
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

    // 儲存到快取
    setCachedWeather(city.toLowerCase(), weatherData);

    console.log(`✅ 成功取得 ${locationName} 天氣資料 (耗時 ${Date.now() - startTime}ms)`);
    res.json({ success: true, data: weatherData, cached: false });

  } catch (error) {
    console.error("❌ 取得天氣失敗:");
    console.error("錯誤訊息:", error.message);
    console.error("錯誤代碼:", error.code);
    
    if (error.response) {
      console.error("API 回應狀態:", error.response.status);
    }

    if (error.code === "ECONNABORTED") {
      return res.status(504).json({
        success: false,
        message: "CWA API 回應超時",
        detail: "請稍後再試"
      });
    }

    if (error.response && error.response.status === 401) {
      return res.status(500).json({
        success: false,
        message: "API 授權失敗",
        detail: "請檢查 CWA_API_KEY 是否正確"
      });
    }

    if (error.response && error.response.status === 429) {
      return res.status(429).json({
        success: false,
        message: "API 呼叫次數超過限制",
        detail: "請稍後再試"
      });
    }

    res.status(500).json({
      success: false,
      message: "伺服器內部錯誤",
      detail: process.env.NODE_ENV === 'production' ? undefined : error.message,
      errorCode: error.code
    });
  }
};

// === 路由定義 ===

// 根路徑 - 返回 API 資訊
app.get("/", (req, res) => {
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  res.json({
    message: "歡迎使用 CWA 天氣預報 API",
    version: "1.0.0",
    endpoints: {
      api_info: `${baseUrl}/api`,
      health: `${baseUrl}/api/health`,
      debug: `${baseUrl}/api/debug`,
      weather: `${baseUrl}/api/weather/{city}`,
      tainan: `${baseUrl}/api/weather/tainan`,
      kaohsiung: `${baseUrl}/api/weather/kaohsiung`,
      taichung: `${baseUrl}/api/weather/taichung`,
      taipei: `${baseUrl}/api/weather/taipei`,
      taoyuan: `${baseUrl}/api/weather/taoyuan`,
      newtaipei: `${baseUrl}/api/weather/newtaipei`,
    },
    supported_cities: Object.keys(CITY_MAP),
    usage: {
      example: `GET ${baseUrl}/api/weather/tainan`,
      description: "使用城市代碼查詢天氣"
    },
    note: "前端網頁介面需另外部署"
  });
});

// API 資訊
app.get("/api", (req, res) => {
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  res.json({
    message: "CWA 天氣預報 API",
    version: "1.0.0",
    endpoints: {
      health: `${baseUrl}/api/health`,
      debug: `${baseUrl}/api/debug`,
      weather: `${baseUrl}/api/weather/{city}`,
    },
    supported_cities: Object.keys(CITY_MAP),
    usage: `GET ${baseUrl}/api/weather/{city}`
  });
});

// 健康檢查
app.get("/api/health", (req, res) => {
  res.json({
    status: "OK",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    cache_size: weatherCache.size
  });
});

// Debug 端點
app.get("/api/debug", (req, res) => {
  res.json({
    status: "debug_info",
    environment: {
      node_env: process.env.NODE_ENV || 'development',
      has_api_key: !!CWA_API_KEY,
      api_key_length: CWA_API_KEY ? CWA_API_KEY.length : 0,
      api_base_url: CWA_API_BASE_URL,
    },
    supported_cities: CITY_MAP,
    cache: {
      size: weatherCache.size,
      keys: Array.from(weatherCache.keys())
    },
    uptime: process.uptime()
  });
});

// 天氣查詢端點
app.get("/api/weather/:city", getCityWeather);

// 清除快取端點
app.post("/api/cache/clear", (req, res) => {
  const size = weatherCache.size;
  weatherCache.clear();
  res.json({
    success: true,
    message: `已清除 ${size} 個快取項目`
  });
});

// 404 處理
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: "路徑不存在",
    path: req.path,
    available_endpoints: ["/", "/api", "/api/health", "/api/debug", "/api/weather/:city"]
  });
});

// 錯誤處理中間件
app.use((err, req, res, next) => {
  console.error("❌ 伺服器錯誤:", err);
  res.status(500).json({
    success: false,
    message: "伺服器內部錯誤",
    error: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// 啟動伺服器
app.listen(PORT, () => {
  console.log(`🚀 伺服器運行於 http://localhost:${PORT}`);
  console.log(`📍 API 端點: http://localhost:${PORT}/api`);
  console.log(`🏥 健康檢查: http://localhost:${PORT}/api/health`);
  console.log(`🌤️  天氣查詢: http://localhost:${PORT}/api/weather/{city}`);
  console.log(`🎯 支援城市: ${Object.keys(CITY_MAP).join(', ')}`);
  console.log(`🔑 API Key 狀態: ${CWA_API_KEY ? '已設定' : '未設定'}`);
});