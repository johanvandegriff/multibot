package k8s

import (
	"context"
	"fmt"
	"log"
	"os"
	"strings"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/kubernetes/scheme"
	"k8s.io/client-go/rest"

	"multibot/common/src/env"
)

var (
	k8sClient *kubernetes.Clientset
)

func Init(channels []string) {
	// Connect to Kubernetes (in-cluster)
	if !env.DISABLE_K8S {
		config, err := rest.InClusterConfig()
		if err != nil {
			log.Fatalf("Error building kube config: %v\n", err)
		}
		k8sClient, err = kubernetes.NewForConfig(config)
		if err != nil {
			log.Fatalf("Error creating Kubernetes client: %v\n", err)
		}
		for _, c := range channels {
			// Spin them up in parallel
			go CreateTenantContainer(c)
		}
	}
}

func loadTenantYAML(channel string) (*appsv1.Deployment, *corev1.Service, error) {
	fileBytes, err := os.ReadFile("tenant-container.yaml")
	if err != nil {
		return nil, nil, err
	}
	text := string(fileBytes)
	text = strings.ReplaceAll(text, "{{IMAGE}}", env.DOCKER_USERNAME+"/multibot-tenant:latest")
	text = strings.ReplaceAll(text, "{{IMAGE_PULL_POLICY}}", env.IMAGE_PULL_POLICY)
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

func CreateTenantContainer(channel string) bool {
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
	if !env.DISABLE_K8S {
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
	if !env.DISABLE_K8S {
		if _, err := k8sClient.CoreV1().Services(svcNamespace).Create(ctx, svc, metav1.CreateOptions{}); err != nil {
			log.Printf("Error creating Service %q in ns %q: %v\n", svc.Name, svcNamespace, err)
			return false
		}
		log.Printf("Created Service %q in ns %q\n", svc.Name, svcNamespace)
	}
	return true
}

func DeleteTenantContainer(channel string) bool {
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
	if !env.DISABLE_K8S {
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
	if !env.DISABLE_K8S {
		if err := k8sClient.CoreV1().Services(svcNamespace).Delete(ctx, svc.Name, metav1.DeleteOptions{}); err != nil {
			log.Printf("Error deleting Service %q in ns %q: %v\n", svc.Name, svcNamespace, err)
			return false
		}
		log.Printf("Deleted Service %q in ns %q\n", svc.Name, svcNamespace)
	}
	return true
}
