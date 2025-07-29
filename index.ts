import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as k8s from "@pulumi/kubernetes";

// ------------------------
// 1. Networking (VPC, Subnets, IGW, Routes)
// ------------------------

const azs = aws.getAvailabilityZones({ state: "available" });

const vpc = new aws.ec2.Vpc("hello-pulumi-vpc", {
    cidrBlock: "10.0.0.0/16",
    enableDnsHostnames: true,
    enableDnsSupport: true,
});

const subnet1 = new aws.ec2.Subnet("hello-pulumi-subnet-1", {
    vpcId: vpc.id,
    cidrBlock: "10.0.1.0/24",
    availabilityZone: pulumi.output(azs).apply((z) => z.names[0]),
    mapPublicIpOnLaunch: true,
});

const subnet2 = new aws.ec2.Subnet("hello-pulumi-subnet-2", {
    vpcId: vpc.id,
    cidrBlock: "10.0.2.0/24",
    availabilityZone: pulumi.output(azs).apply((z) => z.names[1]),
    mapPublicIpOnLaunch: true,
});

const igw = new aws.ec2.InternetGateway("hello-pulumi-igw", { vpcId: vpc.id });

const routeTable = new aws.ec2.RouteTable("hello-pulumi-route-table", {
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
// 2. IAM Roles for EKS Cluster and Nodes
// ------------------------

const clusterRole = new aws.iam.Role("clusterRole", {
    assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
        Service: "eks.amazonaws.com",
    }),
});

new aws.iam.RolePolicyAttachment("clusterPolicyAttach", {
    role: clusterRole.name,
    policyArn: "arn:aws:iam::aws:policy/AmazonEKSClusterPolicy",
});

new aws.iam.RolePolicyAttachment("clusterServicePolicyAttach", {
    role: clusterRole.name,
    policyArn: "arn:aws:iam::aws:policy/AmazonEKSServicePolicy",
});

const nodeRole = new aws.iam.Role("nodeRole", {
    assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
        Service: "ec2.amazonaws.com",
    }),
});

["AmazonEKSWorkerNodePolicy", "AmazonEKS_CNI_Policy", "AmazonEC2ContainerRegistryReadOnly"].forEach(
    (policyName, i) => {
        new aws.iam.RolePolicyAttachment(`nodePolicyAttach-${i}`, {
            role: nodeRole.name,
            policyArn: `arn:aws:iam::aws:policy/${policyName}`,
        });
    }
);

// ------------------------
// 3. Security Groups
// ------------------------

const nodeSg = new aws.ec2.SecurityGroup("node-sg", {
    vpcId: vpc.id,
    ingress: [
        { protocol: "tcp", fromPort: 80, toPort: 80, cidrBlocks: ["0.0.0.0/0"] },
        { protocol: "tcp", fromPort: 5050, toPort: 5050, cidrBlocks: ["0.0.0.0/0"] },
    ],
    egress: [{ protocol: "-1", fromPort: 0, toPort: 0, cidrBlocks: ["0.0.0.0/0"] }],
});

const clusterSg = new aws.ec2.SecurityGroup("cluster-sg", {
    vpcId: vpc.id,
    ingress: [{ protocol: "tcp", fromPort: 443, toPort: 443, cidrBlocks: ["0.0.0.0/0"] }],
    egress: [{ protocol: "-1", fromPort: 0, toPort: 0, cidrBlocks: ["0.0.0.0/0"] }],
});

// ------------------------
// 4. EKS Cluster and NodeGroup
// ------------------------

const cluster = new aws.eks.Cluster("hello-pulumi-cluster", {
    roleArn: clusterRole.arn,
    vpcConfig: {
        subnetIds: [subnet1.id, subnet2.id],
        securityGroupIds: [clusterSg.id],
    },
});

const nodeGroup = new aws.eks.NodeGroup(
    "hello-pulumi-node-group",
    {
        clusterName: cluster.name,
        nodeRoleArn: nodeRole.arn,
        subnetIds: [subnet1.id, subnet2.id],
        scalingConfig: { desiredSize: 2, minSize: 1, maxSize: 3 },
        instanceTypes: ["t3.medium"],
    },
    { dependsOn: [cluster, nodeRole] }
);

// ------------------------
// 5. OIDC Provider and IRSA Role for AppConfig
// ------------------------

const oidcProvider = new aws.iam.OpenIdConnectProvider("eksOidcProvider", {
    clientIdLists: ["sts.amazonaws.com"],
    thumbprintLists: ["9e99a48a9960b14926bb7f3b02e22da2b0ab7280"], // AWS root CA thumbprint
    url: cluster.identities[0].oidcs[0].issuer,
});

const appConfigPolicy = new aws.iam.Policy("appConfigPolicy", {
  policy: JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Action: [
          "appconfig:GetConfiguration",
          "appconfig:StartConfigurationSession",
          "appconfig:GetLatestConfiguration",
          "appconfigdata:StartConfigurationSession",
          "appconfigdata:GetLatestConfiguration"
        ],
        Resource: "*"
      }
    ]
  })
});

const appConfigRole = new aws.iam.Role("appConfigRole", {
    assumeRolePolicy: pulumi.all([oidcProvider.url, oidcProvider.arn]).apply(([url, arn]) =>
        JSON.stringify({
            Version: "2012-10-17",
            Statement: [
                {
                    Effect: "Allow",
                    Principal: { Federated: arn },
                    Action: "sts:AssumeRoleWithWebIdentity",
                    Condition: {
                        StringEquals: {
                            [`${url.replace("https://", "")}:sub`]:
                                "system:serviceaccount:default:hello-pulumi-app-sa",
                        },
                    },
                },
            ],
        })
    ),
});

new aws.iam.RolePolicyAttachment("appConfigRoleAttach", {
    role: appConfigRole.name,
    policyArn: appConfigPolicy.arn,
});

// ------------------------
// 6. Kubeconfig Output
// ------------------------

const kubeconfig = pulumi
    .all([cluster.endpoint, cluster.certificateAuthority, cluster.name])
    .apply(([endpoint, certAuth, name]) => ({
        apiVersion: "v1",
        clusters: [
            {
                cluster: {
                    server: endpoint,
                    "certificate-authority-data": certAuth.data,
                },
                name: "kubernetes",
            },
        ],
        contexts: [
            {
                context: { cluster: "kubernetes", user: "aws" },
                name: "aws",
            },
        ],
        "current-context": "aws",
        kind: "Config",
        users: [
            {
                name: "aws",
                user: {
                    exec: {
                        apiVersion: "client.authentication.k8s.io/v1beta1",
                        command: "aws",
                        args: ["eks", "get-token", "--cluster-name", name],
                    },
                },
            },
        ],
    }));

// ------------------------
// 7. Exports
// ------------------------

export const appConfigRoleArn = appConfigRole.arn;
export const kubeconfigOut = kubeconfig;

export const kubeconfigCmd = kubeconfig.apply(
    () =>
        `pulumi stack output kubeconfigOut > kubeconfig && KUBECONFIG=./kubeconfig kubectl get nodes`
);
