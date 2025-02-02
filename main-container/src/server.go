package main

import (
	"bytes"
	"context"
	"fmt"
	"html/template"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"time"

	"encoding/gob"
	"encoding/json"
	"strings"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"

	"github.com/gorilla/mux"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/kubernetes/scheme"
	"k8s.io/client-go/rest"

	"golang.org/x/oauth2"
	"golang.org/x/oauth2/twitch"
)

const (
	REDIS_NAMESPACE = "multibot"
	PREDIS          = REDIS_NAMESPACE + ":"

	SESSION_COOKIE = "session_id"         // Name of the cookie that stores the session ID.
	SESSION_PREFIX = PREDIS + "sessions/" // Prefix for session keys in Redis.
	SESSION_TTL    = 30 * time.Minute     // How long a session lives in Redis.
)

var (
	rdb               *redis.Client
	k8sClient         *kubernetes.Clientset
	twitchOAuthConfig *oauth2.Config
	indexTemplate     *template.Template

	DISABLE_K8S                 = os.Getenv("DISABLE_K8S") == "true"
	TWITCH_SUPER_ADMIN_USERNAME = os.Getenv("TWITCH_SUPER_ADMIN_USERNAME")
	STATE_DB_URL                = os.Getenv("STATE_DB_URL")
	STATE_DB_PASSWORD           = os.Getenv("STATE_DB_PASSWORD")
	SESSION_SECRET              = os.Getenv("SESSION_SECRET")
	BASE_URL                    = os.Getenv("BASE_URL")
	TWITCH_CLIENT_ID            = os.Getenv("TWITCH_CLIENT_ID")
	TWITCH_SECRET               = os.Getenv("TWITCH_SECRET")
)

// Session holds session data.
type Session struct {
	ID   string                 `json:"id"`
	Data map[string]interface{} `json:"data"`
}

func saveSession(ctx context.Context, session *Session) error {
	var buf bytes.Buffer
	enc := gob.NewEncoder(&buf)
	if err := enc.Encode(session); err != nil {
		return err
	}
	key := SESSION_PREFIX + session.ID
	return rdb.Set(ctx, key, buf.Bytes(), SESSION_TTL).Err()
}

func loadSession(ctx context.Context, sessionID string) (*Session, error) {
	key := SESSION_PREFIX + sessionID
	data, err := rdb.Get(ctx, key).Bytes() // Use .Bytes() when storing raw bytes
	if err == redis.Nil {
		return &Session{
			ID:   sessionID,
			Data: make(map[string]interface{}),
		}, nil
	} else if err != nil {
		return nil, err
	}
	var session Session
	dec := gob.NewDecoder(bytes.NewReader(data))
	if err := dec.Decode(&session); err != nil {
		return nil, err
	}
	return &session, nil
}

// sessionMiddleware is an HTTP middleware that manages sessions.
func sessionMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		var sess *Session

		// Try to get the session cookie.
		cookie, err := r.Cookie(SESSION_COOKIE)
		if err != nil || cookie.Value == "" {
			// No valid session cookie found. Create a new session.
			newSessionID := uuid.New().String()
			sess = &Session{
				ID:   newSessionID,
				Data: make(map[string]interface{}),
			}
			// Set the session cookie.
			http.SetCookie(w, &http.Cookie{
				Name:     SESSION_COOKIE,
				Value:    newSessionID,
				Path:     "/",
				HttpOnly: true,
				// Optionally set Secure, SameSite, etc.
			})
		} else {
			// Load the session from Redis.
			sess, err = loadSession(ctx, cookie.Value)
			if err != nil {
				// On error, log it and create a new session.
				log.Printf("Failed to load session: %v. Creating a new session.", err)
				newSessionID := uuid.New().String()
				sess = &Session{
					ID:   newSessionID,
					Data: make(map[string]interface{}),
				}
				http.SetCookie(w, &http.Cookie{
					Name:     SESSION_COOKIE,
					Value:    newSessionID,
					Path:     "/",
					HttpOnly: true,
				})
			}
		}

		// Store the session in the context.
		ctx = context.WithValue(ctx, "session", sess)

		// Let the next handler handle the request.
		next.ServeHTTP(w, r.WithContext(ctx))

		// Save the session back to Redis.
		if err := saveSession(ctx, sess); err != nil {
			log.Printf("Failed to save session: %v", err)
		}
	})
}


func loadTenantYAML(channel string) (*appsv1.Deployment, *corev1.Service, error) {
	fileBytes, err := os.ReadFile("tenant-container.yaml")
	if err != nil {
		return nil, nil, err
	}
	text := string(fileBytes)
	text = strings.ReplaceAll(text, "{{IMAGE}}", os.Getenv("DOCKER_USERNAME")+"/multibot-tenant:latest")
	text = strings.ReplaceAll(text, "{{IMAGE_PULL_POLICY}}", os.Getenv("IMAGE_PULL_POLICY"))
	text = strings.ReplaceAll(text, "{{CHANNEL}}", channel)

	splitYaml := strings.Split(text, "---")
	if len(splitYaml) != 2 {
		return nil, nil, fmt.Errorf("expected exactly 2 YAML docs (deployment, service)")
	}

	// Create a universal deserializer from client-go.
	decoder := scheme.Codecs.UniversalDeserializer()

	// Decode the deployment YAML.
	obj, _, err := decoder.Decode([]byte(splitYaml[0]), nil, nil)
	if err != nil {
		return nil, nil, fmt.Errorf("error decoding deployment YAML: %w", err)
	}
	dep, ok := obj.(*appsv1.Deployment)
	if !ok {
		return nil, nil, fmt.Errorf("decoded object is not a *appsv1.Deployment")
	}

	// Decode the service YAML.
	objSvc, _, err := decoder.Decode([]byte(splitYaml[1]), nil, nil)
	if err != nil {
		return nil, nil, fmt.Errorf("error decoding service YAML: %w", err)
	}
	svc, ok := objSvc.(*corev1.Service)
	if !ok {
		return nil, nil, fmt.Errorf("decoded object is not a *corev1.Service")
	}

	return dep, svc, nil
}

func createTenantContainer(channel string) bool {
	dep, svc, err := loadTenantYAML(channel)
	if err != nil {
		log.Printf("error loading tenant YAML: %v\n", err)
		return false
	}
	ctx := context.Background()

	depNamespace := dep.GetNamespace()
	if depNamespace == "" {
		return false
	}
	if !DISABLE_K8S {
		if _, err := k8sClient.AppsV1().Deployments(depNamespace).Create(ctx, dep, metav1.CreateOptions{}); err != nil {
			log.Printf("Error creating Deployment %q in ns %q: %v\n", dep.Name, depNamespace, err)
			return false
		}
		log.Printf("Created Deployment %q in ns %q\n", dep.Name, depNamespace)
	}

	svcNamespace := svc.GetNamespace()
	if svcNamespace == "" {
		return false
	}
	if !DISABLE_K8S {
		if _, err := k8sClient.CoreV1().Services(svcNamespace).Create(ctx, svc, metav1.CreateOptions{}); err != nil {
			log.Printf("Error creating Service %q in ns %q: %v\n", svc.Name, svcNamespace, err)
			return false
		}
		log.Printf("Created Service %q in ns %q\n", svc.Name, svcNamespace)
	}
	return true
}

func deleteTenantContainer(channel string) bool {
	dep, svc, err := loadTenantYAML(channel)
	if err != nil {
		log.Printf("error loading tenant YAML: %v\n", err)
		return false
	}
	ctx := context.Background()

	depNamespace := dep.GetNamespace()
	if depNamespace == "" {
		return false
	}
	if !DISABLE_K8S {
		if err := k8sClient.AppsV1().Deployments(depNamespace).Delete(ctx, dep.Name, metav1.DeleteOptions{}); err != nil {
			log.Printf("Error deleting Deployment %q in ns %q: %v\n", dep.Name, depNamespace, err)
			return false
		}
		log.Printf("Deleted Deployment %q in ns %q\n", dep.Name, depNamespace)
	}

	svcNamespace := svc.GetNamespace()
	if svcNamespace == "" {
		return false
	}
	if !DISABLE_K8S {
		if err := k8sClient.CoreV1().Services(svcNamespace).Delete(ctx, svc.Name, metav1.DeleteOptions{}); err != nil {
			log.Printf("Error deleting Service %q in ns %q: %v\n", svc.Name, svcNamespace, err)
			return false
		}
		log.Printf("Deleted Service %q in ns %q\n", svc.Name, svcNamespace)
	}
	return true
}

func isSuperAdmin(user *twitchUser) bool {
	if user == nil {
		return false
	}
	return strings.EqualFold(user.Login, TWITCH_SUPER_ADMIN_USERNAME)
}

// small helper to retrieve the current user from the session
func getSessionUser(r *http.Request) *twitchUser {
	session, ok := r.Context().Value("session").(*Session)
	if !ok {
		return nil
	}
	user, ok := session.Data["twitch_user"].(*twitchUser)
	if !ok {
		return nil
	}
	return user
}

// channelAuthMiddleware ensures the user is either the channel owner or super admin
func channelAuthMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		vars := mux.Vars(r)
		channel := vars["channel"]

		user := getSessionUser(r)
		if user.Login == channel || isSuperAdmin(user) {
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
	inSet, err := rdb.SIsMember(ctx, PREDIS+"channels", channel).Result()
	if err != nil {
		log.Printf("redis SIsMember error: %v", err)
		http.Error(w, "redis error", http.StatusInternalServerError)
		return
	}
	if inSet {
		http.Error(w, "channel already onboarded", http.StatusConflict)
		return
	}

	if !createTenantContainer(channel) {
		http.Error(w, "error creating tenant", http.StatusInternalServerError)
		return
	}

	_, err = rdb.SAdd(ctx, PREDIS+"channels", channel).Result()
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
	inSet, err := rdb.SIsMember(ctx, PREDIS+"channels", channel).Result()
	if err != nil {
		log.Printf("redis SIsMember error: %v", err)
		http.Error(w, "redis error", http.StatusInternalServerError)
		return
	}
	if !inSet {
		http.Error(w, "channel not onboarded", http.StatusConflict)
		return
	}
	if !deleteTenantContainer(channel) {
		http.Error(w, "error deleting tenant", http.StatusInternalServerError)
		return
	}

	// remove the first_run
	rdb.Del(ctx, PREDIS+"channels/"+channel+"/channel_props/did_first_run")
	_, err = rdb.SRem(ctx, PREDIS+"channels", channel).Result()
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
	session, ok := r.Context().Value("session").(*Session)
	if !ok {
		return
	}
	delete(session.Data, "twitch_user")
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
	user := getSessionUser(r) // returns *User or nil

	// Safely log user
	if user == nil {
		log.Println("no twitchUser in session")
	} else {
		log.Println("twitchUser retrieved from session:", user.Login)
	}

	channels, err := rdb.SMembers(r.Context(), PREDIS+"channels").Result()
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
		"is_super_admin": isSuperAdmin(user),
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
	Data []twitchUser `json:"data"`
}

type twitchUser struct {
	ID              string `json:"id"`
	Login           string `json:"login"`
	DisplayName     string `json:"display_name"`
	Type            string `json:"type"`
	BroadcasterType string `json:"broadcaster_type"`
	Description     string `json:"description"`
	ProfileImageUrl string `json:"profile_image_url"`
	OfflineImageUrl string `json:"offline_image_url"`
	ViewCount       int    `json:"view_count"`
	Email           string `json:"email"`
	CreatedAt       string `json:"created_at"`
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
	req.Header.Set("Client-ID", os.Getenv("TWITCH_CLIENT_ID"))

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
	session, ok := r.Context().Value("session").(*Session)
	if !ok {
		http.Error(w, fmt.Sprintf("Session error: %v", err), http.StatusInternalServerError)
		return
	}
	session.Data["twitch_user"] = &user

	channel := user.Login
	inSet, err := rdb.SIsMember(ctx, PREDIS+"channels", channel).Result()
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

var proxyOverrides = make(map[string]string)

func loadProxyOverrides() {
	envVal := os.Getenv("PROXY_OVERRIDES")
	if envVal == "" {
		return
	}
	if err := json.Unmarshal([]byte(envVal), &proxyOverrides); err != nil {
		log.Printf("Error parsing PROXY_OVERRIDES: %v\n", err)
		return
	}
	for channel, target := range proxyOverrides {
		log.Printf("[proxy override] %s => %s\n", channel, target)
	}
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
	gob.Register(&twitchUser{})
	// --------------------------------------------------------------------------
	// 1) Load environment variables
	// --------------------------------------------------------------------------
	port := os.Getenv("PORT")
	if port == "" {
		port = "80"
	}

	// --------------------------------------------------------------------------
	// 2) Set up Redis
	// --------------------------------------------------------------------------
	opt, err := redis.ParseURL(STATE_DB_URL)
	if err != nil {
		log.Fatalf("failed to parse redis URL: %v", err)
	}
	opt.Password = STATE_DB_PASSWORD
	rdb = redis.NewClient(opt)

	ctx := context.Background()
	if err := rdb.Ping(ctx).Err(); err != nil {
		log.Fatalf("redis ping error: %v", err)
	}
	log.Println("Connected to Redis!")


	// --------------------------------------------------------------------------
	// 4) Connect to Kubernetes (in-cluster)
	// --------------------------------------------------------------------------
	if !DISABLE_K8S {
		config, err := rest.InClusterConfig()
		if err != nil {
			log.Fatalf("Error building kube config: %v\n", err)
		}
		k8sClient, err = kubernetes.NewForConfig(config)
		if err != nil {
			log.Fatalf("Error creating Kubernetes client: %v\n", err)
		}
	}

	// --------------------------------------------------------------------------
	// 5) Pre-create any tenant containers for existing channels in Redis
	// --------------------------------------------------------------------------
	channels, _ := rdb.SMembers(ctx, PREDIS+"channels").Result()
	log.Printf("channels onboarded: %v\n", channels)
	if !DISABLE_K8S {
		for _, c := range channels {
			// Spin them up in parallel
			go createTenantContainer(c)
		}
	}

	// --------------------------------------------------------------------------
	// 6) Set up Twitch OAuth config
	// --------------------------------------------------------------------------
	twitchOAuthConfig = &oauth2.Config{
		ClientID:     TWITCH_CLIENT_ID,
		ClientSecret: TWITCH_SECRET,
		RedirectURL:  BASE_URL + "/api/auth/twitch/callback",
		Scopes:       []string{"user_read"}, // Example
		Endpoint:     twitch.Endpoint,
	}

	// --------------------------------------------------------------------------
	// 7) Load index template
	// --------------------------------------------------------------------------
	var errTmpl error
	indexTemplate, errTmpl = template.ParseFiles("index.html") // simplistic approach
	if errTmpl != nil {
		log.Fatalf("Error loading index.html template: %v\n", errTmpl)
	}

	// --------------------------------------------------------------------------
	// 8) Router setup
	// --------------------------------------------------------------------------
	router := mux.NewRouter()

	// Register the session middleware so that all routes have session handling.
	router.Use(sessionMiddleware)
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

	// Logout
	router.HandleFunc("/api/logout", logoutHandler)

	// Root endpoint
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
	loadProxyOverrides()
	for channel, target := range proxyOverrides {
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
		Addr:    ":" + port,
	}

	log.Printf("listening on port %s", port)
	log.Fatal(srv.ListenAndServe())
}
