package coder

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"strconv"
	"strings"
)

// Keyless, well-known data endpoints behind the lookup tool. They are
// variables so tests can point them at a local server.
var (
	lookupGeocodeEndpoint  = "https://geocoding-api.open-meteo.com/v1/search"
	lookupForecastEndpoint = "https://api.open-meteo.com/v1/forecast"
	lookupFXEndpoint       = "https://api.frankfurter.app/latest"
	lookupCryptoEndpoint   = "https://api.coingecko.com/api/v3/simple/price"
	lookupWikiEndpoint     = "https://en.wikipedia.org/api/rest_v1/page/summary/"
)

// lookupTool answers a common factual question from a known source in one call:
// weather, a currency rate, a crypto price or a Wikipedia summary. It exists
// because these are asked constantly and a general web search is a worse path
// to the same answer than the source that publishes it.
type lookupTool struct{}

func (t *lookupTool) Name() string      { return "lookup" }
func (t *lookupTool) Aliases() []string { return []string{"quick_lookup", "get_data"} }
func (t *lookupTool) Mutating() bool    { return false }
func (t *lookupTool) Risk() Risk        { return RiskNetwork }
func (t *lookupTool) Label(a map[string]any) string {
	return "Looking up " + Shorten(argString(a, "kind"), 20) + " " + Shorten(argString(a, "query"), 30)
}
func (t *lookupTool) DoneLabel(a map[string]any) string {
	return "Looked up " + Shorten(argString(a, "kind"), 20)
}
func (t *lookupTool) Description() string {
	return "Answer a common factual question from a known keyless source in one call, instead of a web search: current weather for a place, a currency exchange rate, a crypto price, or a Wikipedia summary. Returns the result directly."
}
func (t *lookupTool) Schema() map[string]any {
	return object(map[string]any{
		"kind":   strProp("One of weather, fx, crypto or wiki."),
		"query":  strProp("Place for weather, coin id for crypto (such as bitcoin), or topic for wiki."),
		"from":   strProp("For fx: the source currency, default USD."),
		"to":     strProp("For fx: the target currency, default IDR."),
		"amount": map[string]any{"type": "number", "description": "For fx: the amount to convert, default 1."},
	}, "kind")
}

func (t *lookupTool) Run(ctx context.Context, env *Env, args map[string]any) (Result, error) {
	kind := strings.ToLower(strings.TrimSpace(argString(args, "kind")))
	switch kind {
	case "weather":
		text, err := lookupWeather(ctx, argString(args, "query"))
		return lookupResult(text, err), nil
	case "fx", "exchange", "rate":
		text, err := lookupFX(ctx, argString(args, "from"), argString(args, "to"), argFloat(args, "amount", 1))
		return lookupResult(text, err), nil
	case "crypto":
		text, err := lookupCrypto(ctx, argString(args, "query"))
		return lookupResult(text, err), nil
	case "wiki", "wikipedia":
		text, err := lookupWiki(ctx, argString(args, "query"))
		return lookupResult(text, err), nil
	default:
		return Result{Output: "kind must be one of weather, fx, crypto or wiki", IsError: true}, nil
	}
}

func lookupResult(text string, err error) Result {
	if err != nil {
		return Result{Output: err.Error(), IsError: true}
	}
	if strings.TrimSpace(text) == "" {
		return Result{Output: "No result."}
	}
	return Result{Output: text}
}

func lookupWeather(ctx context.Context, place string) (string, error) {
	place = strings.TrimSpace(place)
	if place == "" {
		return "", fmt.Errorf("weather needs a place")
	}
	geocodeBody, err := fetchURL(ctx, fmt.Sprintf("%s?name=%s&count=1&language=en&format=json", lookupGeocodeEndpoint, url.QueryEscape(place)))
	if err != nil {
		return "", err
	}
	var geo struct {
		Results []struct {
			Name      string  `json:"name"`
			Country   string  `json:"country"`
			Latitude  float64 `json:"latitude"`
			Longitude float64 `json:"longitude"`
		} `json:"results"`
	}
	if err := json.Unmarshal([]byte(geocodeBody), &geo); err != nil {
		return "", fmt.Errorf("read weather: %v", err)
	}
	if len(geo.Results) == 0 {
		return fmt.Sprintf("No place matched %q.", place), nil
	}
	location := geo.Results[0]
	forecastURL := fmt.Sprintf(
		"%s?latitude=%s&longitude=%s&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code&timezone=auto&forecast_days=1",
		lookupForecastEndpoint,
		strconv.FormatFloat(location.Latitude, 'f', -1, 64),
		strconv.FormatFloat(location.Longitude, 'f', -1, 64),
	)
	forecastBody, err := fetchURL(ctx, forecastURL)
	if err != nil {
		return "", err
	}
	var forecast struct {
		Current struct {
			Temperature   float64 `json:"temperature_2m"`
			Apparent      float64 `json:"apparent_temperature"`
			Humidity      int     `json:"relative_humidity_2m"`
			Precipitation float64 `json:"precipitation"`
			Code          int     `json:"weather_code"`
			Wind          float64 `json:"wind_speed_10m"`
		} `json:"current"`
		Daily struct {
			Max  []float64 `json:"temperature_2m_max"`
			Min  []float64 `json:"temperature_2m_min"`
			Rain []int     `json:"precipitation_probability_max"`
			Code []int     `json:"weather_code"`
		} `json:"daily"`
		Timezone string `json:"timezone"`
	}
	if err := json.Unmarshal([]byte(forecastBody), &forecast); err != nil {
		return "", fmt.Errorf("read weather: %v", err)
	}
	headline := fmt.Sprintf("Weather for %s, %s (%s)", location.Name, location.Country, forecast.Timezone)
	now := fmt.Sprintf("Now: %s C (feels %s), %s", trimFloat(forecast.Current.Temperature), trimFloat(forecast.Current.Apparent), weatherText(forecast.Current.Code))
	now += fmt.Sprintf(", humidity %d%%, wind %s km/h, rain %s mm", forecast.Current.Humidity, trimFloat(forecast.Current.Wind), trimFloat(forecast.Current.Precipitation))
	lines := []string{headline, now}
	if len(forecast.Daily.Max) > 0 && len(forecast.Daily.Min) > 0 {
		today := fmt.Sprintf("Today: %s to %s C, %s", trimFloat(forecast.Daily.Max[0]), trimFloat(forecast.Daily.Min[0]), weatherText(firstCode(forecast.Daily.Code)))
		if len(forecast.Daily.Rain) > 0 {
			today += fmt.Sprintf(", rain chance %d%%", forecast.Daily.Rain[0])
		}
		lines = append(lines, today)
	}
	return strings.Join(lines, "\n"), nil
}

func lookupFX(ctx context.Context, from, to string, amount float64) (string, error) {
	from = strings.ToUpper(strings.TrimSpace(from))
	if from == "" {
		from = "USD"
	}
	to = strings.ToUpper(strings.TrimSpace(to))
	if to == "" {
		to = "IDR"
	}
	if amount <= 0 {
		amount = 1
	}
	body, err := fetchURL(ctx, fmt.Sprintf("%s?from=%s&to=%s", lookupFXEndpoint, url.QueryEscape(from), url.QueryEscape(to)))
	if err != nil {
		return "", err
	}
	var parsed struct {
		Amount float64            `json:"amount"`
		Base   string             `json:"base"`
		Date   string             `json:"date"`
		Rates  map[string]float64 `json:"rates"`
	}
	if err := json.Unmarshal([]byte(body), &parsed); err != nil {
		return "", fmt.Errorf("read exchange rate: %v", err)
	}
	rate, ok := parsed.Rates[to]
	if !ok {
		return fmt.Sprintf("No rate for %s to %s (the source covers major currencies).", from, to), nil
	}
	converted := amount * rate
	return fmt.Sprintf("%s %s = %s %s (1 %s = %s %s, %s)", trimFloat(amount), from, trimFloat(converted), to, from, trimFloat(rate), to, parsed.Date), nil
}

func lookupCrypto(ctx context.Context, coin string) (string, error) {
	coin = strings.ToLower(strings.TrimSpace(coin))
	if coin == "" {
		return "", fmt.Errorf("crypto needs a coin id such as bitcoin or ethereum")
	}
	body, err := fetchURL(ctx, fmt.Sprintf("%s?ids=%s&vs_currencies=usd,idr", lookupCryptoEndpoint, url.QueryEscape(coin)))
	if err != nil {
		return "", err
	}
	var parsed map[string]map[string]float64
	if err := json.Unmarshal([]byte(body), &parsed); err != nil {
		return "", fmt.Errorf("read crypto price: %v", err)
	}
	prices, ok := parsed[coin]
	if !ok || len(prices) == 0 {
		return fmt.Sprintf("No price for %q (use the CoinGecko id, such as bitcoin).", coin), nil
	}
	parts := make([]string, 0, len(prices))
	for _, unit := range []string{"usd", "idr"} {
		if value, ok := prices[unit]; ok {
			parts = append(parts, strings.ToUpper(unit)+" "+trimFloat(value))
		}
	}
	if len(parts) == 0 {
		return fmt.Sprintf("No price for %q.", coin), nil
	}
	return strings.ToUpper(coin) + ": " + strings.Join(parts, ", "), nil
}

func lookupWiki(ctx context.Context, topic string) (string, error) {
	topic = strings.TrimSpace(topic)
	if topic == "" {
		return "", fmt.Errorf("wiki needs a topic")
	}
	body, err := fetchURL(ctx, lookupWikiEndpoint+url.PathEscape(strings.ReplaceAll(topic, " ", "_")))
	if err != nil {
		return "", err
	}
	var parsed struct {
		Title   string `json:"title"`
		Extract string `json:"extract"`
	}
	if err := json.Unmarshal([]byte(body), &parsed); err != nil {
		return "", fmt.Errorf("read summary: %v", err)
	}
	if strings.TrimSpace(parsed.Extract) == "" {
		return fmt.Sprintf("No summary for %q.", topic), nil
	}
	return fmt.Sprintf("%s\n\n%s", parsed.Title, Shorten(parsed.Extract, 1200)), nil
}

// weatherText names a WMO weather code in a few words.
func weatherText(code int) string {
	switch {
	case code == 0:
		return "clear"
	case code <= 3:
		return "partly cloudy"
	case code == 45 || code == 48:
		return "fog"
	case code >= 51 && code <= 57:
		return "drizzle"
	case code >= 61 && code <= 67:
		return "rain"
	case code >= 71 && code <= 77:
		return "snow"
	case code >= 80 && code <= 82:
		return "showers"
	case code == 85 || code == 86:
		return "snow showers"
	case code >= 95:
		return "thunderstorm"
	}
	return "unknown sky"
}

func firstCode(codes []int) int {
	if len(codes) == 0 {
		return -1
	}
	return codes[0]
}

// trimFloat renders a float without a trailing ".0" or noise.
func trimFloat(value float64) string {
	return strconv.FormatFloat(value, 'f', -1, 64)
}

func argFloat(args map[string]any, key string, fallback float64) float64 {
	switch value := args[key].(type) {
	case float64:
		return value
	case int:
		return float64(value)
	case int64:
		return float64(value)
	case string:
		if parsed, err := strconv.ParseFloat(strings.TrimSpace(value), 64); err == nil {
			return parsed
		}
	}
	return fallback
}
