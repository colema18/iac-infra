import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as k8s from "@pulumi/kubernetes";

// ------------------------
// 1. Networking (VPC, Subnets, IGW, Routes)
// ------------------------

const azs = aws.getAvailabilityZones({ state: "available" });

const vpc = new aws.ec2.Vpc("my-vpc", {
    cidrBlock: "10.0.0.0/16",
    enableDnsHostnames: true,
    enableDnsSupport: true,
});

const subnet1 = new aws.ec2.Subnet("my-subnet-1", {
    vpcId: vpc.id,
    cidrBlock: "10.0.1.0/24",
    availabilityZone: pulumi.output(azs).apply(z => z.names[0]),
    mapPublicIpOnLaunch: true,
});

const subnet2 = new aws.ec2.Subnet("my-subnet-2", {
    vpcId: vpc.id,
    cidrBlock: "10.0.2.0/24",
    availabilityZone: pulumi.output(azs).apply(z => z.names[1]),
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

// Security Group for Nodes
const nodeSg = new aws.ec2.SecurityGroup("node-sg", {
    vpcId: vpc.id,
    ingress: [
        { protocol: "tcp", fromPort: 80, toPort: 80, cidrBlocks: ["0.0.0.0/0"] },
        { protocol: "tcp", fromPort: 5050, toPort: 5050, cidrBlocks: ["0.0.0.0/0"] },
    ],
    egress: [{ protocol: "-1", fromPort: 0, toPort: 0, cidrBlocks: ["0.0.0.0/0"] }],
});

// Security Group for Cluster API access
const clusterSg = new aws.ec2.SecurityGroup("cluster-sg", {
    vpcId: vpc.id,
    ingress: [{ protocol: "tcp", fromPort: 443, toPort: 443, cidrBlocks: ["0.0.0.0/0"] }],
    egress: [{ protocol: "-1", fromPort: 0, toPort: 0, cidrBlocks: ["0.0.0.0/0"] }],
});

// ------------------------
// 3. EKS Cluster
// ------------------------

const cluster = new aws.eks.Cluster("my-cluster", {
    roleArn: clusterRole.arn,
    vpcConfig: {
        subnetIds: [subnet1.id, subnet2.id],
        securityGroupIds: [clusterSg.id],
    },
});

const nodeGroup = new aws.eks.NodeGroup(
    "my-node-group",
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
// 4. Kubeconfig & Provider
// ------------------------

const kubeconfig = pulumi.all([cluster.endpoint, cluster.certificateAuthority, cluster.name]).apply(
    ([endpoint, certAuth, name]) => ({
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
    })
);

// ------------------------
// 5. Exports
// ------------------------

export const kubeconfigOut = kubeconfig;

export const kubeconfigCmd = kubeconfig.apply(
    () => `pulumi stack output kubeconfigOut > kubeconfig && KUBECONFIG=./kubeconfig kubectl get nodes`
);
