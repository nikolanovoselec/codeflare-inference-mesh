package agent

import (
	"fmt"
	"runtime"
)

type ServiceInstall struct {
	Platform string `json:"platform"`
	UnitName string `json:"unitName"`
	Command  string `json:"command"`
	Config   string `json:"config"`
}

func ServiceInstallPlan(binaryPath string, configPath string, platform string) ServiceInstall {
	if platform == "" {
		platform = runtime.GOOS
	}
	switch platform {
	case "windows":
		return ServiceInstall{Platform: platform, UnitName: "InferenceMeshAgent", Command: fmt.Sprintf("%s run --config %s", binaryPath, configPath), Config: "sc.exe create InferenceMeshAgent binPath= \"" + binaryPath + " run\" start= auto"}
	case "darwin":
		return ServiceInstall{Platform: platform, UnitName: "com.inference-mesh.agent", Command: fmt.Sprintf("%s run --config %s", binaryPath, configPath), Config: "launchd plist with KeepAlive=true and localhost dashboard"}
	default:
		return ServiceInstall{Platform: "linux", UnitName: "inference-mesh-agent.service", Command: fmt.Sprintf("%s run --config %s", binaryPath, configPath), Config: "systemd service with Restart=always and private tmp"}
	}
}

const ServiceAnchors = "REQ-NODE-001"
