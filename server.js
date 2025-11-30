require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const path = require("path");

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
    const locationName = CITY_MAP[city.toLowerCase()];

    if (!locationName) {
      return res.status(400).json({
        success: false,
        error: "不支援的城市",
        message: `有效城市代碼: ${Object.keys(CITY_MAP).join(", ")}`
      });
    }

    // API Key 檢查
    if (!CWA_API_KEY) {
      console.error("缺少 CWA_API_KEY");
      return res.status(500).json({
        success: false,
        message: "伺服器設定錯誤，缺少 CWA_API_KEY"
      });
    }

    const response = await axios.get(
      `${CWA_API_BASE_URL}/v1/rest/datastore/F-C0032-001`,
      {
        headers: { 'Authorization': CWA_API_KEY },
        params: { locationName },
        timeout: 8000,
      }
    );

    const locationData = response.data.records.location[0];

    if (!locationData) {
      return res.status(404).json({
        success: false,
        message: `查無 ${locationName} 天氣資料`
      });
    }

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

    res.json({ success: true, data: weatherData });

  } catch (error) {
    console.error("❌ 取得天氣失敗:", error.message);

    if (error.code === "ECONNABORTED") {
      return res.status(504).json({
        success: false,
        message: "CWA API 回應超時",
      });
    }

    res.status(500).json({
      success: false,
      message: "伺服器內部錯誤",
      detail: error.message,
    });
  }
};

// API 路由
app.get("/api/weather/:city", getCityWeather);
app.get("/api/health", (req, res) => {
  res.json({
    status: "OK",
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

// ⭐⭐⭐ 最重要：正確送出根目錄的 index.html （無 public 資料夾）
app.get("/", (req, res) => {
  res.sendFile(path.join(process.cwd(), "index.html"));
});

// 404
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: "路徑不存在",
    path: req.path
  });
});

// 啟動
app.listen(PORT, () => {
  console.log(`🚀 伺服器運行於 http://localhost:${PORT}`);
});
