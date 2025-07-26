import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as k8s from "@pulumi/kubernetes";

// ------------------------
// 1. Networking (VPC, Subnets, IGW, Routes)
// ------------------------

const vpc = new aws.ec2.Vpc("my-vpc", {
    cidrBlock: "10.0.0.0/16",
    enableDnsHostnames: true,
    enableDnsSupport: true,
});

const subnet1 = new aws.ec2.Subnet("my-subnet-1", {
    vpcId: vpc.id,
    cidrBlock: "10.0.1.0/24",
    availabilityZone: "us-east-1a",
    mapPublicIpOnLaunch: true,
});

const subnet2 = new aws.ec2.Subnet("my-subnet-2", {
    vpcId: vpc.id,
    cidrBlock: "10.0.2.0/24",
    availabilityZone: "us-east-1b",
    mapPublicIpOnLaunch: true,
});

const igw = new aws.ec2.InternetGateway("my-igw", { vpcId: vpc.id });

const routeTable = new aws.ec2.RouteTable("my-route-table", {
    vpcId: vpc.id,
    routes: [{ cidrBlock: "0.0.0.0/0", gatewayId: igw.id }],
});

new aws.ec2.RouteTableAssociation("rt-assoc-1", {
    subnetId: subnet1.id,
    routeTableId: routeTable.id,
});
new aws.ec2.RouteTableAssociation("rt-assoc-2", {
    subnetId: subnet2.id,
    routeTableId: routeTable.id,
});

// ------------------------
// 2. IAM Roles for EKS
// ------------------------

const clusterRole = new aws.iam.Role("clusterRole", {
    assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
        Service: "eks.amazonaws.com",
    }),
});

// Attach required cluster policies
new aws.iam.RolePolicyAttachment("clusterPolicyAttach", {
    role: clusterRole.name,
    policyArn: "arn:aws:iam::aws:policy/AmazonEKSClusterPolicy",
});

new aws.iam.RolePolicyAttachment("clusterServicePolicyAttach", {
    role: clusterRole.name,
    policyArn: "arn:aws:iam::aws:policy/AmazonEKSServicePolicy",
});

// Node group role
const nodeRole = new aws.iam.Role("nodeRole", {
    assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
        Service: "ec2.amazonaws.com",
    }),
});

["AmazonEKSWorkerNodePolicy", "AmazonEKS_CNI_Policy", "AmazonEC2ContainerRegistryReadOnly"].forEach((policyName, i) => {
    new aws.iam.RolePolicyAttachment(`nodePolicyAttach-${i}`, {
        role: nodeRole.name,
        policyArn: `arn:aws:iam::aws:policy/${policyName}`,
    });
});

// ------------------------
// 3. EKS Cluster (latest version)
// ------------------------

const cluster = new aws.eks.Cluster("my-cluster", {
    roleArn: clusterRole.arn,
    vpcConfig: {
        subnetIds: [subnet1.id, subnet2.id],
    },
});

// Managed Node Group
const nodeGroup = new aws.eks.NodeGroup("my-node-group", {
    clusterName: cluster.name,
    nodeRoleArn: nodeRole.arn,
    subnetIds: [subnet1.id, subnet2.id],
    scalingConfig: { desiredSize: 2, minSize: 1, maxSize: 3 },
    instanceTypes: ["t3.medium"],
});

// ------------------------
// 4. CoreDNS Addon
// ------------------------

const coreDnsVersion = aws.eks.getAddonVersionOutput({
    addonName: "coredns",
    kubernetesVersion: cluster.version,
    mostRecent: true,
});

const coreDnsAddon = new aws.eks.Addon("coreDnsAddon", {
    clusterName: cluster.name,
    addonName: "coredns",
    addonVersion: coreDnsVersion.version,
    resolveConflictsOnUpdate: "PRESERVE",
}, { dependsOn: cluster });

// ------------------------
// 5. Kubeconfig
// ------------------------

const kubeconfig = pulumi.all([cluster.endpoint, cluster.certificateAuthority, cluster.name]).apply(
  ([endpoint, certAuth, name]) => ({
    apiVersion: "v1",
    clusters: [{
      cluster: {
        server: endpoint,
        "certificate-authority-data": certAuth.data,
      },
      name: "kubernetes",
    }],
    contexts: [{
      context: { cluster: "kubernetes", user: "aws" },
      name: "aws",
    }],
    "current-context": "aws",
    kind: "Config",
    users: [{
      name: "aws",
      user: {
        exec: {
          apiVersion: "client.authentication.k8s.io/v1beta1",
          command: "aws",
          args: ["eks", "get-token", "--cluster-name", name],
        },
      },
    }],
  })
);

const provider = new k8s.Provider("k8s-provider", {
  kubeconfig: kubeconfig.apply(JSON.stringify),
});

// ------------------------
// 6. Backend Deployment & Service
// ------------------------

const backEndDeployment = new k8s.apps.v1.Deployment("backend-deployment", {
    spec: {
        selector: { matchLabels: { app: "backend" } },
        replicas: 2,
        template: {
            metadata: { labels: { app: "backend" } },
            spec: {
                containers: [{
                    name: "backend",
                    image: "ghcr.io/colema18/hello-pulumi-app:latest",
                    ports: [{ containerPort: 5050 }],
                }],
            },
        },
    },
}, { provider });

const backEndService = new k8s.core.v1.Service("backend-service", {
    spec: {
        type: "ClusterIP",
        selector: backEndDeployment.spec.template.metadata.labels,
        ports: [{ port: 5050, targetPort: 5050 }],
    },
}, { provider });

// ------------------------
// 7. Frontend Deployment & Service
// ------------------------

const frontEndDeployment = new k8s.apps.v1.Deployment("frontend-deployment", {
    spec: {
        selector: { matchLabels: { app: "frontend" } },
        replicas: 2,
        template: {
            metadata: { labels: { app: "frontend" } },
            spec: {
                containers: [{
                    name: "frontend",
                    image: "ghcr.io/colema18/hello-pulumi-ui:latest",
                    ports: [{ containerPort: 80 }],
                    env: [{
                        name: "API_URL",
                        value: backEndService.metadata.apply(
                          m => `http://${m.name}.${m.namespace}.svc.cluster.local:5050`
                        ),
                    }],
                }],
            },
        },
    },
}, { provider });

const frontEndService = new k8s.core.v1.Service("frontend-service", {
    spec: {
        type: "LoadBalancer",
        selector: frontEndDeployment.spec.template.metadata.labels,
        ports: [{ port: 80, targetPort: 80 }],
    },
}, { provider });

// ------------------------
// 8. Exports
// ------------------------

export const kubeconfigOut = kubeconfig;

export const frontEndUrl = frontEndService.status.loadBalancer.ingress.apply(
  ingress =>
    ingress && ingress[0]?.hostname
      ? `http://${ingress[0].hostname}`
      : "pending..."
);
