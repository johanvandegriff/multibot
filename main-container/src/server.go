package main

import (
	"fmt"
	"html/template"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"time"

	"encoding/gob"
	"encoding/json"
	"strings"

	"github.com/gorilla/mux"

	"golang.org/x/oauth2"
	"golang.org/x/oauth2/twitch"

	"multibot/common/env"
	"multibot/common/redisClient"
	"multibot/common/redisSession"

	"multibot/main-container/src/k8s"
)

var (
	twitchOAuthConfig *oauth2.Config
	indexTemplate     *template.Template
)

// channelAuthMiddleware ensures the user is either the channel owner or super admin
func channelAuthMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		vars := mux.Vars(r)
		channel := vars["channel"]

		user, isSuperAdmin := redisSession.GetSessionUser(r)
		if user.Login == channel || isSuperAdmin {
			next.ServeHTTP(w, r)
		} else {
			http.Error(w, "Forbidden", http.StatusForbidden)
		}
	})
}

// onboardHandler -> /api/onboard/{channel}
func onboardHandler(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	channel := vars["channel"]
	if channel == "" {
		http.Error(w, "invalid channel", http.StatusBadRequest)
		return
	}

	ctx := r.Context()
	inSet, err := redisClient.SIsMember(ctx, "channels", channel).Result()
	if err != nil {
		log.Printf("redis SIsMember error: %v", err)
		http.Error(w, "redis error", http.StatusInternalServerError)
		return
	}
	if inSet {
		http.Error(w, "channel already onboarded", http.StatusConflict)
		return
	}

	if !k8s.CreateTenantContainer(channel) {
		http.Error(w, "error creating tenant", http.StatusInternalServerError)
		return
	}

	_, err = redisClient.SAdd(ctx, "channels", channel).Result()
	if err != nil {
		log.Printf("redis SAdd error: %v", err)
		http.Error(w, "redis error", http.StatusInternalServerError)
		return
	}

	log.Printf("onboarded %s\n", channel)
	io.WriteString(w, "ok\n")
}

// offboardHandler -> /api/offboard/{channel}
func offboardHandler(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	channel := vars["channel"]
	if channel == "" {
		http.Error(w, "invalid channel", http.StatusBadRequest)
		return
	}

	ctx := r.Context()
	inSet, err := redisClient.SIsMember(ctx, "channels", channel).Result()
	if err != nil {
		log.Printf("redis SIsMember error: %v", err)
		http.Error(w, "redis error", http.StatusInternalServerError)
		return
	}
	if !inSet {
		http.Error(w, "channel not onboarded", http.StatusConflict)
		return
	}
	if !k8s.DeleteTenantContainer(channel) {
		http.Error(w, "error deleting tenant", http.StatusInternalServerError)
		return
	}

	// remove the first_run
	redisClient.Del(ctx, "channels/"+channel+"/channel_props/did_first_run")
	_, err = redisClient.SRem(ctx, "channels", channel).Result()
	if err != nil {
		log.Printf("redis SRem error: %v", err)
		http.Error(w, "redis error", http.StatusInternalServerError)
		return
	}

	log.Printf("offboarded %s\n", channel)
	io.WriteString(w, "ok\n")
}

// logoutHandler -> /api/logout
func logoutHandler(w http.ResponseWriter, r *http.Request) {
	redisSession.DeleteSessionUser(r)
	// optional: redirect to homepage or other
	returnTo := r.URL.Query().Get("returnTo")
	if returnTo == "" {
		http.Redirect(w, r, "/", http.StatusFound)
	} else {
		http.Redirect(w, r, "/"+returnTo, http.StatusFound)
	}
}

// indexHandler -> GET /
func indexHandler(w http.ResponseWriter, r *http.Request) {
	user, isSuperAdmin := redisSession.GetSessionUser(r) // returns *User or nil

	// Safely log user
	if user == nil {
		log.Println("no twitchUser in session")
	} else {
		log.Println("twitchUser retrieved from session:", user.Login)
	}

	channels, err := redisClient.SMembers(r.Context(), "channels").Result()
	if err != nil {
		log.Printf("redis SMembers error: %v", err)
	}

	userBytes, err := json.Marshal(user)
	if err != nil {
		log.Fatalf("error converting user to json: %v", err)
	}

	data := map[string]any{
		"channel":        nil,
		"channels":       strings.Join(channels, ","),
		"user":           string(userBytes), // can be nil, that’s fine for the template
		"is_super_admin": isSuperAdmin,
	}
	indexTemplate.Execute(w, data)
}

// twitchOAuthHandlers - minimal example using golang.org/x/oauth2
// In a real solution, handle CSRF state, error handling, etc.
func twitchLoginHandler(w http.ResponseWriter, r *http.Request) {
	// Create a random 'state' in production
	url := twitchOAuthConfig.AuthCodeURL("some-random-state", oauth2.AccessTypeOffline)
	http.Redirect(w, r, url, http.StatusFound)
}

type twitchUserResp struct {
	Data []redisSession.TwitchUser `json:"data"`
}

func twitchCallbackHandler(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	state := r.URL.Query().Get("state")
	code := r.URL.Query().Get("code")

	// Validate your 'state' in a real app:
	if state != "some-random-state" {
		http.Error(w, "Invalid state", http.StatusBadRequest)
		return
	}

	// Exchange the code for an oauth2.Token
	token, err := twitchOAuthConfig.Exchange(ctx, code)
	if err != nil {
		http.Error(w, fmt.Sprintf("OAuth exchange failed: %v", err), http.StatusBadRequest)
		return
	}

	// The returned token includes the bearer token info:
	//   token.AccessToken
	//   token.RefreshToken
	//   token.Expiry
	//   etc.

	// Build an http.Client that automatically uses token.AccessToken
	client := twitchOAuthConfig.Client(ctx, token)

	// Prepare the Twitch Helix /users request (Bearer token is added by client)
	req, err := http.NewRequest("GET", "https://api.twitch.tv/helix/users", nil)
	if err != nil {
		http.Error(w, fmt.Sprintf("Creating user info request failed: %v", err), http.StatusBadRequest)
		return
	}
	// Add the required Client-ID header
	req.Header.Set("Client-ID", env.TWITCH_CLIENT_ID)

	resp, err := client.Do(req)
	if err != nil {
		http.Error(w, fmt.Sprintf("Fetching Twitch user info failed: %v", err), http.StatusBadRequest)
		return
	}
	defer resp.Body.Close()

	// Parse the JSON response, which looks like:
	// {
	//   "data": [
	//     {
	//       "id": "...",
	//       "login": "...",
	//       "display_name": "...",
	//       ...
	//     }
	//   ]
	// }
	bodyBytes, _ := io.ReadAll(resp.Body)
	// log.Printf("Twitch Helix /users response: %s", bodyBytes)

	var helixResp twitchUserResp
	if err := json.Unmarshal(bodyBytes, &helixResp); err != nil {
		http.Error(w, fmt.Sprintf("JSON parse error: %v", err), http.StatusBadRequest)
		return
	}
	// Make sure there's at least one user in the data array
	if len(helixResp.Data) == 0 {
		http.Error(w, "No user returned from Twitch", http.StatusBadRequest)
		return
	}
	// Make sure there's only one user in the data array
	if len(helixResp.Data) > 1 {
		http.Error(w, "Expected 1 user returned from Twitch but got multiple", http.StatusBadRequest)
		return
	}

	// Fill your user object
	user := helixResp.Data[0]
	// Capture the token info in the user struct
	// user.AccessToken = token.AccessToken
	// user.RefreshToken = token.RefreshToken

	log.Println("twitchUser parsed from twitch:", user.Login)

	// Save user to session
	err = redisSession.SetSessionUser(r, &user)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	channel := user.Login
	inSet, err := redisClient.SIsMember(ctx, "channels", channel).Result()
	if err != nil {
		log.Printf("redis SIsMember error: %v", err)
		http.Error(w, "redis error", http.StatusInternalServerError)
		return
	}
	if inSet {
		//if the channel has a tenant container, go there
		http.Redirect(w, r, "/"+channel, http.StatusFound)
	} else {
		//otherwise go to the homepage which has instructions to sign up
		http.Redirect(w, r, "/", http.StatusFound)
	}
}

func parseProxyOverrides() map[string]string {
	proxyOverrides := make(map[string]string)

	if env.PROXY_OVERRIDES == "" {
		return nil
	}
	if err := json.Unmarshal([]byte(env.PROXY_OVERRIDES), &proxyOverrides); err != nil {
		log.Printf("Error parsing PROXY_OVERRIDES: %v\n", err)
		return nil
	}
	for channel, target := range proxyOverrides {
		log.Printf("[proxy override] %s => %s\n", channel, target)
	}

	return proxyOverrides
}

func createSingleHostProxy(target string) http.Handler {
	targetURL, err := url.Parse(target)
	if err != nil {
		log.Fatalf("invalid proxy target %q: %v", target, err)
	}

	proxy := httputil.NewSingleHostReverseProxy(targetURL)

	// Optionally define a custom error handler, websockets, etc.
	proxy.ErrorHandler = func(rw http.ResponseWriter, req *http.Request, e error) {
		log.Printf("[proxy error] channel override to %s => %v", target, e)
		http.Error(rw, "Proxy Error", http.StatusBadGateway)
	}

	return proxy
}

func main() {
	gob.Register(&redisSession.TwitchUser{})

	redisClient.Init()

	// Pre-create any tenant containers for existing channels in Redis
	channels, _ := redisClient.SMembers(nil, "channels").Result()
	log.Printf("channels onboarded: %v\n", channels)
	k8s.Init(channels)

	// Set up Twitch OAuth config
	twitchOAuthConfig = &oauth2.Config{
		ClientID:     env.TWITCH_CLIENT_ID,
		ClientSecret: env.TWITCH_SECRET,
		RedirectURL:  env.BASE_URL + "/api/auth/twitch/callback",
		Scopes:       []string{"user_read"}, // Example
		Endpoint:     twitch.Endpoint,
	}

	// Load index template
	var errTmpl error
	indexTemplate, errTmpl = template.ParseFiles("index.html") // simplistic approach
	if errTmpl != nil {
		log.Fatalf("Error loading index.html template: %v\n", errTmpl)
	}

	// Router setup
	router := mux.NewRouter()

	// Register the session middleware so that all routes have session handling.
	router.Use(redisSession.SessionMiddleware)
	// for consideration of using channel URLs directly, and having non-channel URLs be invalid usernames:
	// Your Twitch username must be between 4 and 25 characters—no more, no less. Secondly, only letters A-Z, numbers 0-9, and underscores (_) are allowed. All other special characters are prohibited, but users are increasingly calling for the restriction to be relaxed in the future.
	// need to make sure non-channel URLs contain a "-" or are 3 chars long, e.g. "/twitch-auth", "/log-out", "/new", "/api", etc.
	// if owncast is added as a primary login, make sure that the url has a "." in it, e.g. "jjv.sh" to distinguish it from twitch

	// Twitch OAuth
	router.HandleFunc("/api/auth/twitch", twitchLoginHandler)
	router.HandleFunc("/api/auth/twitch/callback", twitchCallbackHandler)

	// Onboard/Offboard
	router.Handle("/api/onboard/{channel}", channelAuthMiddleware(http.HandlerFunc(onboardHandler)))
	router.Handle("/api/offboard/{channel}", channelAuthMiddleware(http.HandlerFunc(offboardHandler)))

	router.HandleFunc("/api/logout", logoutHandler)
	router.HandleFunc("/", indexHandler)

	// Tell the router to use that file server for all /static/* paths
	router.PathPrefix("/api/static/").Handler(http.StripPrefix("/api/static/", http.FileServer(http.Dir("./static"))))

	router.HandleFunc("/favicon.ico", func(w http.ResponseWriter, r *http.Request) {
		http.ServeFile(w, r, "static/favicon.ico")
	})
	router.HandleFunc("/favicon.png", func(w http.ResponseWriter, r *http.Request) {
		http.ServeFile(w, r, "static/favicon.png")
	})

	//create separate routes for proxy overrides, only used to run locally without k8s
	for channel, target := range parseProxyOverrides() {
		routePath := "/" + channel
		router.PathPrefix(routePath).Handler(
			http.StripPrefix(routePath, createSingleHostProxy(target)),
		)
	}

	router.PathPrefix("/{channel}").HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		channel := mux.Vars(req)["channel"]

		targetHost := fmt.Sprintf("http://tenant-container-%s-svc:8000", channel)
		parsedURL, err := url.Parse(targetHost)
		if err != nil {
			log.Printf("error parsing target host: %v", err)
			http.NotFound(w, req)
			return
		}

		proxy := httputil.NewSingleHostReverseProxy(parsedURL)

		// Set a custom transport with a short dial timeout.
		proxy.Transport = &http.Transport{
			DialContext: (&net.Dialer{
				Timeout:   2 * time.Second, // adjust timeout as needed
				KeepAlive: 30 * time.Second,
			}).DialContext,
			TLSHandshakeTimeout: 2 * time.Second,
		}

		proxy.ErrorHandler = func(rw http.ResponseWriter, r *http.Request, e error) {
			now := time.Now().UnixMilli()
			log.Printf("[main] 404 %d channel: %s proxy error: %v", now, channel, e)
			html := fmt.Sprintf(`<h1>404 - Channel Not Found</h1>
<p>The requested URL was not found on this server.</p>
<p>If this is your username, <a href="/api/auth/twitch">log in</a> and sign up to activate it.</p>
<p>If you have already signed up but still see an error, send me a screenshot of this page to troubleshoot.</p>
<p><a href="/">back to homepage</a></p>
<p>[main] timestamp: %d</p>`, now)
			rw.WriteHeader(http.StatusNotFound)
			rw.Header().Set("Content-Type", "text/html; charset=utf-8")
			_, _ = rw.Write([]byte(html))
		}

		// Strip the channel prefix so that the upstream receives the correct path.
		http.StripPrefix("/"+channel, proxy).ServeHTTP(w, req)
	})

	srv := &http.Server{
		Handler: router,
		Addr:    ":" + env.PORT,
	}

	log.Printf("listening on port %s", env.PORT)
	log.Fatal(srv.ListenAndServe())
}
